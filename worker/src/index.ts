/**
 * TavernSync Cloudflare Worker — Durable Object for manifest CAS + R2 blobs.
 *
 * Auth: Authorization: Bearer <deviceToken>
 * Soft R2 budgets (Storage / Class A / Class B) with Discord operator alerts — never blocks sync.
 */

export interface Env {
    MANIFEST_DO: DurableObjectNamespace;
    BLOBS: R2Bucket;
    USER_TOKENS: KVNamespace;
    /** @deprecated use SOFT_STORAGE_BYTES */
    DEFAULT_QUOTA_BYTES?: string;
    SOFT_STORAGE_BYTES?: string;
    SOFT_CLASS_A_MONTHLY?: string;
    SOFT_CLASS_B_MONTHLY?: string;
    /** Operator Discord webhook; empty = metering only */
    DISCORD_WEBHOOK_URL?: string;
}

const MAX_BLOB = 25 * 1024 * 1024;
const MAX_MANIFEST = 2 * 1024 * 1024;
const DEFAULT_SOFT_STORAGE = 50 * 1024 * 1024 * 1024; // 50 GiB
const DEFAULT_SOFT_CLASS_A = 100_000;
const DEFAULT_SOFT_CLASS_B = 1_000_000;
const ALERT_LEVELS = [70, 90, 100] as const;

type Meter = 'storage' | 'classA' | 'classB';
type AlertsSent = Partial<Record<Meter, number>>;
type MonthOps = { classA: number; classB: number };

function corsHeaders(): HeadersInit {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
        'Access-Control-Expose-Headers': 'ETag, X-Manifest-Version',
    };
}

async function resolveUser(env: Env, request: Request): Promise<string | null> {
    const auth = request.headers.get('Authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) return null;
    const token = m[1].trim();
    if (!token) return null;
    const userId = await env.USER_TOKENS.get(token);
    return userId || (token.length >= 8 ? `user_${token.slice(0, 16)}` : null);
}

function doStub(env: Env, userId: string): DurableObjectStub {
    const id = env.MANIFEST_DO.idFromName(userId);
    return env.MANIFEST_DO.get(id);
}

function utcPeriod(d = new Date()): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function softLimits(env: Env): { storageBytes: number; classA: number; classB: number } {
    const storageBytes = Number(
        env.SOFT_STORAGE_BYTES
        || env.DEFAULT_QUOTA_BYTES
        || DEFAULT_SOFT_STORAGE,
    );
    return {
        storageBytes: Number.isFinite(storageBytes) && storageBytes > 0 ? storageBytes : DEFAULT_SOFT_STORAGE,
        classA: Math.max(1, Number(env.SOFT_CLASS_A_MONTHLY || DEFAULT_SOFT_CLASS_A) || DEFAULT_SOFT_CLASS_A),
        classB: Math.max(1, Number(env.SOFT_CLASS_B_MONTHLY || DEFAULT_SOFT_CLASS_B) || DEFAULT_SOFT_CLASS_B),
    };
}

function levelForPct(pct: number): number {
    let level = 0;
    for (const t of ALERT_LEVELS) {
        if (pct >= t) level = t;
    }
    return level;
}

function pctOf(used: number, limit: number): number {
    if (limit <= 0) return 0;
    return (used / limit) * 100;
}

/** Fire-and-forget usage accounting + soft-limit Discord alerts. */
async function recordUsage(
    env: Env,
    ctx: ExecutionContext,
    userId: string,
    body: { classA?: number; classB?: number; hash?: string; size?: number },
): Promise<void> {
    const p = doStub(env, userId).fetch('https://do/usage-incr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...body }),
    });
    ctx.waitUntil(p.then(async (res) => {
        if (!res.ok) console.error('usage-incr failed', userId, res.status, await res.text().catch(() => ''));
    }).catch((e) => console.error('usage-incr error', userId, e)));
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders() });
        }

        const url = new URL(request.url);
        const userId = await resolveUser(env, request);
        if (!userId) {
            return json({ error: 'unauthorized' }, 401);
        }

        try {
            if (url.pathname === '/v1/manifest' && request.method === 'GET') {
                return withCors(await doStub(env, userId).fetch('https://do/manifest', { method: 'GET' }));
            }
            if (url.pathname === '/v1/manifest' && request.method === 'PUT') {
                const ifMatch = request.headers.get('If-Match') || '0';
                const body = await request.arrayBuffer();
                if (body.byteLength > MAX_MANIFEST) {
                    return json({ error: 'manifest_too_large' }, 413);
                }
                return withCors(await doStub(env, userId).fetch('https://do/manifest', {
                    method: 'PUT',
                    headers: { 'If-Match': ifMatch, 'Content-Type': 'application/json' },
                    body,
                }));
            }

            if (url.pathname === '/v1/blobs/check' && request.method === 'POST') {
                const { hashes } = await request.json() as { hashes: string[] };
                const list = hashes || [];
                const flags = await Promise.all(list.map(async (hash) => {
                    const key = `u/${userId}/b/${hash}`;
                    const head = await env.BLOBS.head(key);
                    return head ? null : hash;
                }));
                if (list.length) {
                    await recordUsage(env, ctx, userId, { classB: list.length });
                }
                return json({ missing: flags.filter((h): h is string => h != null) });
            }

            const blobMatch = /^\/v1\/blobs\/([a-f0-9]+)$/i.exec(url.pathname);
            if (blobMatch) {
                const hash = blobMatch[1].toLowerCase();
                const key = `u/${userId}/b/${hash}`;
                if (request.method === 'GET') {
                    try {
                        const obj = await env.BLOBS.get(key);
                        if (!obj) return json({ error: 'not_found' }, 404);
                        const bytes = await obj.arrayBuffer();
                        await recordUsage(env, ctx, userId, { classB: 1 });
                        return new Response(bytes, {
                            headers: {
                                ...corsHeaders(),
                                'Content-Type': 'application/octet-stream',
                                'Cache-Control': 'immutable',
                            },
                        });
                    } catch (e) {
                        console.error('blob GET failed', key, e);
                        return json({ error: 'blob_read_failed', detail: String(e) }, 404);
                    }
                }
                if (request.method === 'PUT') {
                    const data = new Uint8Array(await request.arrayBuffer());
                    if (data.byteLength > MAX_BLOB) return json({ error: 'blob_too_large' }, 413);
                    await env.BLOBS.put(key, data);
                    // Await size + soft-limit accounting (Discord alerts deduped inside DO).
                    await doStub(env, userId).fetch('https://do/usage-incr', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            userId,
                            classA: 1,
                            hash,
                            size: data.byteLength,
                        }),
                    });
                    return json({ ok: true });
                }
            }

            if (url.pathname === '/v1/quota' && request.method === 'GET') {
                return withCors(await doStub(env, userId).fetch('https://do/quota', { method: 'GET' }));
            }

            if (url.pathname === '/v1/account' && request.method === 'GET') {
                return withCors(await doStub(env, userId).fetch('https://do/account', { method: 'GET' }));
            }
            if (url.pathname === '/v1/account' && request.method === 'PUT') {
                const body = await request.text();
                return withCors(await doStub(env, userId).fetch('https://do/account', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                }));
            }

            if (url.pathname === '/v1/gc' && request.method === 'POST') {
                return withCors(await doStub(env, userId).fetch('https://do/gc', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId }),
                }));
            }

            return json({ error: 'not_found' }, 404);
        } catch (e) {
            return json({ error: String(e) }, 500);
        }
    },
};

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
}

function withCors(res: Response): Response {
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders())) {
        headers.set(k, v);
    }
    return new Response(res.body, { status: res.status, headers });
}

export class ManifestDO {
    state: DurableObjectState;
    env: Env;

    constructor(state: DurableObjectState, env: Env) {
        this.state = state;
        this.env = env;
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/manifest' && request.method === 'GET') {
            const version = (await this.state.storage.get<number>('version')) || 0;
            const manifest = (await this.state.storage.get<unknown>('manifest')) || null;
            return new Response(JSON.stringify({ manifest, version }), {
                headers: {
                    'Content-Type': 'application/json',
                    ETag: `"${version}"`,
                    'X-Manifest-Version': String(version),
                },
            });
        }

        if (url.pathname === '/manifest' && request.method === 'PUT') {
            const ifMatch = Number(request.headers.get('If-Match') || '0');
            const current = (await this.state.storage.get<number>('version')) || 0;
            if (ifMatch !== current) {
                return new Response(JSON.stringify({ error: 'conflict', version: current }), { status: 412 });
            }
            const manifest = await request.json();
            const next = current + 1;
            await this.state.storage.put('manifest', manifest);
            await this.state.storage.put('version', next);
            const items = (manifest as { items?: Record<string, { hash: string }> })?.items || {};
            const hashes = Object.values(items).map((i) => i.hash);
            await this.state.storage.put('blob_hashes', hashes);
            return new Response(JSON.stringify({ version: next }), {
                headers: { 'Content-Type': 'application/json', ETag: `"${next}"` },
            });
        }

        if (url.pathname === '/usage-incr' && request.method === 'POST') {
            const body = await request.json() as {
                userId?: string;
                classA?: number;
                classB?: number;
                hash?: string;
                size?: number;
            };
            await this.applyUsageIncr(body);
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Legacy alias — size accounting now goes through /usage-incr
        if (url.pathname === '/blob-put' && request.method === 'POST') {
            const { hash, size } = await request.json() as { hash: string; size: number };
            await this.applyUsageIncr({ classA: 1, hash, size });
            return new Response(JSON.stringify({ ok: true }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (url.pathname === '/quota' && request.method === 'GET') {
            const snap = await this.usageSnapshot();
            return new Response(JSON.stringify({
                // Back-compat for extension Connect line (used + files only on client now)
                usedBytes: snap.storage.usedBytes,
                limitBytes: snap.storage.softBytes,
                itemCount: snap.storage.itemCount,
                period: snap.period,
                storage: snap.storage,
                classA: snap.classA,
                classB: snap.classB,
                alerts: snap.alerts,
            }), { headers: { 'Content-Type': 'application/json' } });
        }

        if (url.pathname === '/account' && request.method === 'GET') {
            const e2eeSalt = (await this.state.storage.get<string>('e2eeSalt')) || null;
            return new Response(JSON.stringify({ e2eeSalt }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (url.pathname === '/account' && request.method === 'PUT') {
            const body = await request.json() as { e2eeSalt?: string };
            if (!body.e2eeSalt || typeof body.e2eeSalt !== 'string') {
                return new Response(JSON.stringify({ error: 'e2eeSalt required' }), { status: 400 });
            }
            const existing = await this.state.storage.get<string>('e2eeSalt');
            if (existing && existing !== body.e2eeSalt) {
                return new Response(JSON.stringify({ error: 'salt_exists', e2eeSalt: existing }), { status: 409 });
            }
            if (!existing) {
                await this.state.storage.put('e2eeSalt', body.e2eeSalt);
            }
            return new Response(JSON.stringify({ e2eeSalt: existing || body.e2eeSalt }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (url.pathname === '/gc' && request.method === 'POST') {
            return new Response(JSON.stringify({ ok: true, note: 'gc stub — use external cron for R2 orphans' }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response('not found', { status: 404 });
    }

    private async applyUsageIncr(body: {
        userId?: string;
        classA?: number;
        classB?: number;
        hash?: string;
        size?: number;
    }): Promise<void> {
        if (body.hash && typeof body.size === 'number' && body.size >= 0) {
            const sizes = (await this.state.storage.get<Record<string, number>>('blob_sizes')) || {};
            sizes[body.hash] = body.size;
            await this.state.storage.put('blob_sizes', sizes);
        }

        const period = utcPeriod();
        const opsKey = `ops:${period}`;
        const ops = (await this.state.storage.get<MonthOps>(opsKey)) || { classA: 0, classB: 0 };
        if (body.classA) ops.classA += body.classA;
        if (body.classB) ops.classB += body.classB;
        await this.state.storage.put(opsKey, ops);

        const userId = body.userId || 'unknown';
        // Await so alerts_sent is updated before the next serialized DO request (dedupe).
        try {
            await this.maybeNotifySoftLimits(userId, period, ops);
        } catch (e) {
            console.error('soft-limit notify failed', userId, e);
        }
    }

    private async storageUsedBytes(): Promise<{ used: number; itemCount: number }> {
        const sizes = (await this.state.storage.get<Record<string, number>>('blob_sizes')) || {};
        const hashes = (await this.state.storage.get<string[]>('blob_hashes')) || [];
        let used = 0;
        for (const h of hashes) used += sizes[h] || 0;
        return { used, itemCount: hashes.length };
    }

    private async usageSnapshot() {
        const limits = softLimits(this.env);
        const period = utcPeriod();
        const ops = (await this.state.storage.get<MonthOps>(`ops:${period}`)) || { classA: 0, classB: 0 };
        const { used, itemCount } = await this.storageUsedBytes();
        const storagePct = pctOf(used, limits.storageBytes);
        const classAPct = pctOf(ops.classA, limits.classA);
        const classBPct = pctOf(ops.classB, limits.classB);
        const alerts: { meter: Meter; level: number }[] = [];
        for (const [meter, pct] of [
            ['storage', storagePct],
            ['classA', classAPct],
            ['classB', classBPct],
        ] as const) {
            const level = levelForPct(pct);
            if (level) alerts.push({ meter, level });
        }
        return {
            period,
            storage: {
                usedBytes: used,
                softBytes: limits.storageBytes,
                itemCount,
                pct: storagePct,
            },
            classA: { used: ops.classA, softLimit: limits.classA, pct: classAPct },
            classB: { used: ops.classB, softLimit: limits.classB, pct: classBPct },
            alerts,
        };
    }

    private async maybeNotifySoftLimits(userId: string, period: string, ops: MonthOps): Promise<void> {
        const webhook = (this.env.DISCORD_WEBHOOK_URL || '').trim();
        if (!webhook) return;

        const limits = softLimits(this.env);
        const { used } = await this.storageUsedBytes();
        const meters: { meter: Meter; used: number; softLimit: number; pct: number; unit: string }[] = [
            {
                meter: 'storage',
                used,
                softLimit: limits.storageBytes,
                pct: pctOf(used, limits.storageBytes),
                unit: 'bytes',
            },
            {
                meter: 'classA',
                used: ops.classA,
                softLimit: limits.classA,
                pct: pctOf(ops.classA, limits.classA),
                unit: 'ops',
            },
            {
                meter: 'classB',
                used: ops.classB,
                softLimit: limits.classB,
                pct: pctOf(ops.classB, limits.classB),
                unit: 'ops',
            },
        ];

        const alertsKey = `alerts_sent:${period}`;
        const sent = (await this.state.storage.get<AlertsSent>(alertsKey)) || {};
        let changed = false;

        for (const m of meters) {
            const level = levelForPct(m.pct);
            const prev = sent[m.meter] || 0;
            if (level > prev) {
                sent[m.meter] = level;
                changed = true;
                await this.postDiscordAlert(webhook, {
                    userId,
                    period,
                    meter: m.meter,
                    level,
                    used: m.used,
                    softLimit: m.softLimit,
                    pct: m.pct,
                    unit: m.unit,
                });
            }
        }

        if (changed) {
            await this.state.storage.put(alertsKey, sent);
        }
    }

    private async postDiscordAlert(
        webhook: string,
        info: {
            userId: string;
            period: string;
            meter: Meter;
            level: number;
            used: number;
            softLimit: number;
            pct: number;
            unit: string;
        },
    ): Promise<void> {
        const labels: Record<Meter, string> = {
            storage: 'Storage',
            classA: 'Class A (writes)',
            classB: 'Class B (reads)',
        };
        const color = info.level >= 100 ? 0xe74c3c : info.level >= 90 ? 0xe67e22 : 0xf1c40f;
        const usedLabel = info.unit === 'bytes'
            ? `${formatBytes(info.used)} / ${formatBytes(info.softLimit)}`
            : `${info.used.toLocaleString()} / ${info.softLimit.toLocaleString()} ops`;

        const res = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title: `TavernSync soft limit — ${labels[info.meter]} ${info.level}%`,
                    color,
                    fields: [
                        { name: 'userId', value: info.userId, inline: true },
                        { name: 'period', value: info.period, inline: true },
                        { name: 'meter', value: labels[info.meter], inline: true },
                        { name: 'usage', value: usedLabel, inline: true },
                        { name: 'pct', value: `${info.pct.toFixed(1)}%`, inline: true },
                    ],
                    footer: { text: 'Soft limit only — sync is not blocked' },
                    timestamp: new Date().toISOString(),
                }],
            }),
        });
        if (!res.ok) {
            console.error('Discord webhook failed', res.status, await res.text().catch(() => ''));
        }
    }
}

function formatBytes(n: number): string {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}
