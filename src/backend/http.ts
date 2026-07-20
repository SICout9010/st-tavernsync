import { ConflictError, type StorageAdapter } from './adapter';
import type { Manifest } from '../sync-core/types';
import { LOG_PREFIX } from '../settings';

export interface HttpAdapterOptions {
    endpoint: string;
    deviceToken: string;
}

function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...extra,
    };
}

async function readError(res: Response): Promise<string> {
    try {
        return await res.text();
    } catch {
        return res.statusText;
    }
}

export class HttpStorageAdapter implements StorageAdapter {
    constructor(private opts: HttpAdapterOptions) {}

    private url(path: string): string {
        const base = this.opts.endpoint.replace(/\/+$/, '');
        return `${base}${path}`;
    }

    async getManifest(): Promise<{ manifest: Manifest | null; version: number }> {
        const res = await fetch(this.url('/v1/manifest'), {
            headers: authHeaders(this.opts.deviceToken),
        });
        if (res.status === 404) {
            return { manifest: null, version: 0 };
        }
        if (!res.ok) {
            throw new Error(`getManifest: ${res.status} ${await readError(res)}`);
        }
        const version = Number(res.headers.get('ETag')?.replace(/"/g, '') || res.headers.get('X-Manifest-Version') || 0);
        const body = await res.json() as { manifest: Manifest | null; version?: number };
        return {
            manifest: body.manifest,
            version: body.version ?? version,
        };
    }

    async putManifest(m: Manifest, ifVersion: number): Promise<{ version: number }> {
        const res = await fetch(this.url('/v1/manifest'), {
            method: 'PUT',
            headers: authHeaders(this.opts.deviceToken, { 'If-Match': String(ifVersion) }),
            body: JSON.stringify(m),
        });
        if (res.status === 412) {
            throw new ConflictError();
        }
        if (!res.ok) {
            throw new Error(`putManifest: ${res.status} ${await readError(res)}`);
        }
        const body = await res.json() as { version: number };
        return { version: body.version };
    }

    async checkBlobs(hashes: string[]): Promise<string[]> {
        const res = await fetch(this.url('/v1/blobs/check'), {
            method: 'POST',
            headers: authHeaders(this.opts.deviceToken),
            body: JSON.stringify({ hashes }),
        });
        if (!res.ok) {
            throw new Error(`checkBlobs: ${res.status} ${await readError(res)}`);
        }
        const body = await res.json() as { missing: string[] };
        return body.missing || [];
    }

    async getBlob(hash: string): Promise<Uint8Array> {
        const res = await fetch(this.url(`/v1/blobs/${encodeURIComponent(hash)}`), {
            headers: { Authorization: `Bearer ${this.opts.deviceToken}` },
        });
        if (!res.ok) {
            throw new Error(`getBlob ${hash}: ${res.status}`);
        }
        return new Uint8Array(await res.arrayBuffer());
    }

    async putBlob(hash: string, data: Uint8Array): Promise<void> {
        const res = await fetch(this.url(`/v1/blobs/${encodeURIComponent(hash)}`), {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${this.opts.deviceToken}`,
                'Content-Type': 'application/octet-stream',
            },
            body: data as unknown as BodyInit,
        });
        if (!res.ok) {
            console.error(LOG_PREFIX, 'putBlob failed', hash, res.status);
            throw new Error(`putBlob ${hash}: ${res.status}`);
        }
    }

    async quota(): Promise<{ usedBytes: number; limitBytes: number; itemCount: number }> {
        const res = await fetch(this.url('/v1/quota'), {
            headers: authHeaders(this.opts.deviceToken),
        });
        if (!res.ok) {
            return { usedBytes: 0, limitBytes: 0, itemCount: 0 };
        }
        return await res.json() as { usedBytes: number; limitBytes: number; itemCount: number };
    }
}

/** Upload missing blobs with concurrency cap 4 + simple backoff. */
export async function uploadBlobsParallel(
    adapter: StorageAdapter,
    entries: { hash: string; data: Uint8Array }[],
    concurrency = 4,
): Promise<void> {
    const missing = await adapter.checkBlobs(entries.map((e) => e.hash));
    const need = new Set(missing);
    const queue = entries.filter((e) => need.has(e.hash));

    let i = 0;
    async function worker() {
        while (i < queue.length) {
            const idx = i++;
            const entry = queue[idx];
            let attempt = 0;
            for (;;) {
                try {
                    await adapter.putBlob(entry.hash, entry.data);
                    break;
                } catch (e) {
                    attempt++;
                    if (attempt >= 3) throw e;
                    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
                }
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()));
}
