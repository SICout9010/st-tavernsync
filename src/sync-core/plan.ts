import type { ApplyOp, DiffEntry } from './types';

export interface PlanOptions {
    propagateDeletes: boolean;
    /** Item types allowed to sync in this run */
    allowedTypes?: Set<string>;
}

/**
 * Turn diff entries into an ordered apply plan.
 * Dependency order for pulls is enforced later in apply.
 */
export function buildPlan(entries: DiffEntry[], opts: PlanOptions): ApplyOp[] {
    const ops: ApplyOp[] = [];
    const allowed = opts.allowedTypes;

    for (const e of entries) {
        if (allowed && e.type && !allowed.has(e.type)) {
            ops.push({ id: e.id, kind: 'skip', type: e.type || 'settings', meta: { reason: 'out_of_scope' } });
            continue;
        }

        switch (e.action) {
            case 'in_sync':
                break;
            case 'push':
            case 'push_new':
                ops.push({
                    id: e.id,
                    kind: 'push_blob',
                    type: e.type || e.local!.type,
                    hash: e.local!.hash,
                });
                break;
            case 'pull':
            case 'pull_new':
                ops.push({
                    id: e.id,
                    kind: 'pull_blob',
                    type: e.type || e.remote!.type,
                    hash: e.remote!.hash,
                });
                break;
            case 'conflict':
                ops.push({
                    id: e.id,
                    kind: 'keep_both',
                    type: e.type || e.local?.type || e.remote!.type,
                    meta: { localHash: e.local?.hash, remoteHash: e.remote?.hash },
                });
                break;
            case 'local_delete':
                if (opts.propagateDeletes) {
                    ops.push({
                        id: e.id,
                        kind: 'tombstone',
                        type: e.type || e.base!.type,
                        meta: { side: 'remote' },
                    });
                } else {
                    ops.push({
                        id: e.id,
                        kind: 'skip',
                        type: e.type || e.base!.type,
                        meta: { reason: 'local_delete_not_propagated' },
                    });
                }
                break;
            case 'remote_delete':
                // Never auto-apply in v1
                ops.push({
                    id: e.id,
                    kind: 'skip',
                    type: e.type || e.base!.type,
                    meta: { reason: 'remote_delete_needs_confirm' },
                });
                break;
        }
    }

    return ops;
}

/** Pull apply order from CONTEXT §5. */
export const PULL_TYPE_ORDER = [
    'worldinfo',
    'preset',
    'character',
    'chat',
    'group',
    'groupchat',
    'persona',
    'quickreply',
    'theme',
    'settings',
] as const;

export function sortPullOps(ops: ApplyOp[]): ApplyOp[] {
    const rank = new Map(PULL_TYPE_ORDER.map((t, i) => [t, i]));
    return [...ops].sort((a, b) => {
        const ra = rank.get(a.type as typeof PULL_TYPE_ORDER[number]) ?? 50;
        const rb = rank.get(b.type as typeof PULL_TYPE_ORDER[number]) ?? 50;
        return ra - rb || a.id.localeCompare(b.id);
    });
}
