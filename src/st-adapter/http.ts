/** Same-origin ST API helpers via getContext().getRequestHeaders. */

import { LOG_PREFIX } from '../settings';

export function getCtx() {
    return SillyTavern.getContext();
}

export async function stFetchJson<T = unknown>(
    url: string,
    body: unknown = {},
    init: RequestInit = {},
): Promise<T> {
    const ctx = getCtx();
    const headers = {
        ...ctx.getRequestHeaders(),
        ...(init.headers as Record<string, string> | undefined),
    };
    const res = await fetch(url, {
        method: 'POST',
        ...init,
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(LOG_PREFIX, `ST API ${url} → ${res.status}`, text);
        throw new Error(`ST API ${url} failed: ${res.status}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
        return (await res.json()) as T;
    }
    // Some endpoints return empty / plain
    const text = await res.text();
    try {
        return JSON.parse(text) as T;
    } catch {
        return text as unknown as T;
    }
}

export async function stFetchBytes(url: string): Promise<Uint8Array> {
    const res = await fetch(url, { cache: 'reload' });
    if (!res.ok) {
        throw new Error(`GET ${url} failed: ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
}

export async function stFetchForm<T = unknown>(url: string, form: FormData): Promise<T> {
    const ctx = getCtx();
    const headers = ctx.getRequestHeaders({ omitContentType: true });
    const res = await fetch(url, { method: 'POST', headers, body: form });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(LOG_PREFIX, `ST form ${url} → ${res.status}`, text);
        throw new Error(`ST form ${url} failed: ${res.status}`);
    }
    return (await res.json()) as T;
}
