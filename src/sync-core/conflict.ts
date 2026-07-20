/**
 * Chat fast-forward: if one message array is a strict prefix of the other, take the longer.
 * Pure — operates on already-parsed message arrays (including optional header at [0]).
 */

export type FastForwardResult =
    | { kind: 'same' }
    | { kind: 'fast_forward'; winner: 'local' | 'remote'; messages: unknown[] }
    | { kind: 'diverged' };

function messageFingerprint(msg: unknown): string {
    if (!msg || typeof msg !== 'object') return JSON.stringify(msg);
    const m = msg as Record<string, unknown>;
    // Prefer stable content fields; ignore volatile extras where possible
    return JSON.stringify({
        name: m.name,
        is_user: m.is_user,
        mes: m.mes,
        send_date: m.send_date,
    });
}

function stripHeader(messages: unknown[]): { header: unknown | null; body: unknown[] } {
    if (!messages.length) return { header: null, body: [] };
    const first = messages[0];
    if (first && typeof first === 'object' && 'chat_metadata' in (first as object)) {
        return { header: first, body: messages.slice(1) };
    }
    return { header: null, body: messages };
}

function isPrefix(shorter: unknown[], longer: unknown[]): boolean {
    if (shorter.length > longer.length) return false;
    for (let i = 0; i < shorter.length; i++) {
        if (messageFingerprint(shorter[i]) !== messageFingerprint(longer[i])) {
            return false;
        }
    }
    return true;
}

export function tryChatFastForward(local: unknown[], remote: unknown[]): FastForwardResult {
    const L = stripHeader(local);
    const R = stripHeader(remote);

    if (L.body.length === R.body.length && isPrefix(L.body, R.body)) {
        return { kind: 'same' };
    }

    if (isPrefix(L.body, R.body)) {
        const header = R.header || L.header;
        const messages = header ? [header, ...R.body] : R.body;
        return { kind: 'fast_forward', winner: 'remote', messages };
    }

    if (isPrefix(R.body, L.body)) {
        const header = L.header || R.header;
        const messages = header ? [header, ...L.body] : L.body;
        return { kind: 'fast_forward', winner: 'local', messages };
    }

    return { kind: 'diverged' };
}

/** Suffixed conflict id for "keep both". */
export function conflictSiblingId(id: string, deviceLabel: string, when = new Date()): string {
    const stamp = when.toISOString().slice(0, 10);
    const safe = deviceLabel.replace(/[^\w.-]+/g, '_').slice(0, 32);
    // chat/avatar/name → chat/avatar/name (conflict DATE device)
    const parts = id.split('/');
    if (parts[0] === 'chat' && parts.length >= 3) {
        const file = parts.slice(2).join('/');
        return `${parts[0]}/${parts[1]}/${file} (conflict ${stamp} ${safe})`;
    }
    if (parts[0] === 'groupchat' && parts.length >= 2) {
        return `${parts[0]}/${parts.slice(1).join('/')} (conflict ${stamp} ${safe})`;
    }
    return `${id} (conflict ${stamp} ${safe})`;
}
