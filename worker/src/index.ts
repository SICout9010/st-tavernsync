/**
 * TavernSync Cloudflare Worker — Durable Object for manifest CAS + R2 blobs.
 *
 * Auth: Authorization: Bearer <deviceToken>
 * Tokens are mapped to userId via env binding KV or hardcoded demo map for self-host.
 */

export interface Env {
    MANIFEST_DO: DurableObjectNamespace;
    BLOBS: R2Bucket;
    USER_TOKENS: KVNamespace;
    DEFAULT_QUOTA_BYTES: string;
}

const MAX_BLOB = 25 * 1024 * 1024;
const MAX_MANIFEST = 2 * 1024 * 1024;

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

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
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
                const missing: string[] = [];
                for (const hash of hashes || []) {
                    const key = `u/${userId}/b/${hash}`;
                    const head = await env.BLOBS.head(key);
                    if (!head) missing.push(hash);
                }
                return json({ missing });
            }

            const blobMatch = /^\/v1\/blobs\/([a-f0-9]+)$/i.exec(url.pathname);
            if (blobMatch) {
                const hash = blobMatch[1].toLowerCase();
                const key = `u/${userId}/b/${hash}`;
                if (request.method === 'GET') {
                    const obj = await env.BLOBS.get(key);
                    if (!obj) return json({ error: 'not_found' }, 404);
                    return new Response(obj.body, {
                        headers: {
                            ...corsHeaders(),
                            'Content-Type': 'application/octet-stream',
                            'Cache-Control': 'immutable',
                        },
                    });
                }
                if (request.method === 'PUT') {
                    const data = new Uint8Array(await request.arrayBuffer());
                    if (data.byteLength > MAX_BLOB) return json({ error: 'blob_too_large' }, 413);
                    await env.BLOBS.put(key, data);
                    // Notify DO for quota accounting
                    await doStub(env, userId).fetch('https://do/blob-put', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ hash, size: data.byteLength }),
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
            // Update referenced blob set for GC
            const items = (manifest as { items?: Record<string, { hash: string }> })?.items || {};
            const hashes = Object.values(items).map((i) => i.hash);
            await this.state.storage.put('blob_hashes', hashes);
            return new Response(JSON.stringify({ version: next }), {
                headers: { 'Content-Type': 'application/json', ETag: `"${next}"` },
            });
        }

        if (url.pathname === '/blob-put' && request.method === 'POST') {
            const { hash, size } = await request.json() as { hash: string; size: number };
            const sizes = (await this.state.storage.get<Record<string, number>>('blob_sizes')) || {};
            sizes[hash] = size;
            await this.state.storage.put('blob_sizes', sizes);
            return new Response(JSON.stringify({ ok: true }));
        }

        if (url.pathname === '/quota' && request.method === 'GET') {
            const sizes = (await this.state.storage.get<Record<string, number>>('blob_sizes')) || {};
            const hashes = (await this.state.storage.get<string[]>('blob_hashes')) || [];
            let used = 0;
            for (const h of hashes) used += sizes[h] || 0;
            const limit = Number(this.env.DEFAULT_QUOTA_BYTES || 500 * 1024 * 1024);
            return new Response(JSON.stringify({
                usedBytes: used,
                limitBytes: limit,
                itemCount: hashes.length,
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
            // First writer wins — all devices must share the same account salt for HMAC blob keys
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
            // GC is best-effort; full R2 listing omitted in DO-only stub
            return new Response(JSON.stringify({ ok: true, note: 'gc stub — use external cron for R2 orphans' }), {
                headers: { 'Content-Type': 'application/json' },
            });
        }

        return new Response('not found', { status: 404 });
    }
}
