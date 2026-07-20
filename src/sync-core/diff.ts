import type { DiffEntry, Manifest, SyncItem } from './types';

/**
 * 3-way diff: local vs base vs remote.
 * Covers all branches from CONTEXT §5.
 */
export function diffManifests(
    local: Manifest,
    base: Manifest | null,
    remote: Manifest | null,
): DiffEntry[] {
    const localItems = local.items || {};
    const baseItems = base?.items || {};
    const remoteItems = remote?.items || {};
    const ids = new Set([
        ...Object.keys(localItems),
        ...Object.keys(baseItems),
        ...Object.keys(remoteItems),
    ]);

    const entries: DiffEntry[] = [];

    for (const id of ids) {
        const L = localItems[id];
        const B = baseItems[id];
        const R = remoteItems[id];
        entries.push(classify(id, L, B, R));
    }

    return entries;
}

function classify(
    id: string,
    L?: SyncItem,
    B?: SyncItem,
    R?: SyncItem,
): DiffEntry {
    const lHash = L?.hash;
    const bHash = B?.hash;
    const rHash = R?.hash;
    const type = L?.type || R?.type || B?.type;

    // Both absent somehow
    if (!L && !R && !B) {
        return { id, action: 'in_sync', type };
    }

    // In sync (same hash, both exist)
    if (L && R && lHash === rHash) {
        return { id, action: 'in_sync', type, local: L, base: B, remote: R };
    }

    // New local
    if (L && !B && !R) {
        return { id, action: 'push_new', type, local: L };
    }

    // New remote
    if (R && !B && !L) {
        return { id, action: 'pull_new', type, remote: R };
    }

    // Local delete (was in base, gone locally)
    if (B && !L) {
        return { id, action: 'local_delete', type, base: B, remote: R };
    }

    // Remote delete (was in base, gone remotely)
    if (B && !R) {
        return { id, action: 'remote_delete', type, local: L, base: B };
    }

    // Classic 3-way
    if (B && L && R) {
        if (bHash === rHash && lHash !== bHash) {
            return { id, action: 'push', type, local: L, base: B, remote: R };
        }
        if (bHash === lHash && rHash !== bHash) {
            return { id, action: 'pull', type, local: L, base: B, remote: R };
        }
        if (lHash !== bHash && rHash !== bHash) {
            return { id, action: 'conflict', type, local: L, base: B, remote: R };
        }
    }

    // Local exists, remote missing but no base → treat as push new-ish
    if (L && !R) {
        return { id, action: 'push', type, local: L, base: B };
    }
    if (R && !L) {
        return { id, action: 'pull', type, remote: R, base: B };
    }

    return { id, action: 'conflict', type, local: L, base: B, remote: R };
}

export function summarizeDiff(entries: DiffEntry[]): {
    push: number;
    pull: number;
    conflict: number;
    inSync: number;
    localDelete: number;
    remoteDelete: number;
} {
    const s = { push: 0, pull: 0, conflict: 0, inSync: 0, localDelete: 0, remoteDelete: 0 };
    for (const e of entries) {
        switch (e.action) {
            case 'push':
            case 'push_new':
                s.push++;
                break;
            case 'pull':
            case 'pull_new':
                s.pull++;
                break;
            case 'conflict':
                s.conflict++;
                break;
            case 'in_sync':
                s.inSync++;
                break;
            case 'local_delete':
                s.localDelete++;
                break;
            case 'remote_delete':
                s.remoteDelete++;
                break;
        }
    }
    return s;
}
