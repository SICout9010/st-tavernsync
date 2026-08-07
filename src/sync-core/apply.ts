import type { ApplyOp } from './types';
import { sortPullOps } from './plan';
import { mapPool } from '../util/pool';

const BLOB_CONCURRENCY = 4;

export interface ApplyContext {
    dryRun: boolean;
    log: (msg: string, meta?: unknown) => void;
    /** Per-blob push (fallback when pushBlobs is omitted). */
    pushBlob: (id: string, hash: string) => Promise<void>;
    /**
     * Batch push — preferred. Called once with every push_blob op so the
     * caller can encrypt once and upload with real concurrency.
     */
    pushBlobs?: (items: { id: string; hash: string }[]) => Promise<void>;
    pullAndApply: (id: string, type: ApplyOp['type'], hash: string) => Promise<void>;
    keepBoth: (id: string, type: ApplyOp['type']) => Promise<void>;
    tombstone: (id: string) => Promise<void>;
    /** Max parallel pull/keep_both within a type group. Default 4. */
    concurrency?: number;
}

/**
 * Execute plan. Every destructive path goes through here.
 * Logs the full plan before executing.
 */
export async function applyOp(ops: ApplyOp[], ctx: ApplyContext): Promise<{ done: number; skipped: number; failed: string[] }> {
    ctx.log('Plan', ops);
    const pullOps = sortPullOps(ops.filter((o) => o.kind === 'pull_blob' || o.kind === 'keep_both'));
    const pushOps = ops.filter((o) => o.kind === 'push_blob');
    const other = ops.filter((o) => o.kind !== 'pull_blob' && o.kind !== 'keep_both' && o.kind !== 'push_blob');

    let done = 0;
    let skipped = 0;
    const failed: string[] = [];
    const concurrency = ctx.concurrency ?? BLOB_CONCURRENCY;

    const run = async (op: ApplyOp) => {
        try {
            if (op.kind === 'skip') {
                skipped++;
                ctx.log('skip', op);
                return;
            }
            if (ctx.dryRun || op.dryRun) {
                ctx.log('dry-run', op);
                done++;
                return;
            }
            switch (op.kind) {
                case 'push_blob':
                    await ctx.pushBlob(op.id, op.hash!);
                    break;
                case 'pull_blob':
                    await ctx.pullAndApply(op.id, op.type, op.hash!);
                    break;
                case 'keep_both':
                    await ctx.keepBoth(op.id, op.type);
                    break;
                case 'tombstone':
                    await ctx.tombstone(op.id);
                    break;
                case 'apply_local':
                    await ctx.pullAndApply(op.id, op.type, op.hash!);
                    break;
            }
            done++;
        } catch (e) {
            failed.push(op.id);
            ctx.log('failed', { op, error: String(e) });
            throw e;
        }
    };

    // Push first: one batch when pushBlobs is provided (real 4-wide upload).
    if (pushOps.length) {
        if (ctx.dryRun) {
            for (const op of pushOps) await run(op);
        } else if (ctx.pushBlobs) {
            try {
                await ctx.pushBlobs(pushOps.map((op) => ({ id: op.id, hash: op.hash! })));
                done += pushOps.length;
                for (const op of pushOps) ctx.log('push_blob', op);
            } catch (e) {
                for (const op of pushOps) failed.push(op.id);
                ctx.log('failed', { ops: pushOps, error: String(e) });
                throw e;
            }
        } else {
            await mapPool(pushOps, concurrency, (op) => run(op));
        }
    }

    // Pulls: preserve type order (settings before personas), parallel within type.
    for (const group of groupByType(pullOps)) {
        await mapPool(group, concurrency, (op) => run(op));
    }

    for (const op of other) await run(op);

    return { done, skipped, failed };
}

/** Consecutive type groups in already-sorted pull order. */
function groupByType(ops: ApplyOp[]): ApplyOp[][] {
    const groups: ApplyOp[][] = [];
    for (const op of ops) {
        const last = groups[groups.length - 1];
        if (last && last[0].type === op.type) last.push(op);
        else groups.push([op]);
    }
    return groups;
}
