import { describe, expect, it, vi } from 'vitest';
import { applyOp, type ApplyContext } from '../apply';
import type { ApplyOp } from '../types';

function baseCtx(over: Partial<ApplyContext> = {}): ApplyContext {
    return {
        dryRun: false,
        log: () => undefined,
        pushBlob: vi.fn(async () => undefined),
        pullAndApply: vi.fn(async () => undefined),
        keepBoth: vi.fn(async () => undefined),
        tombstone: vi.fn(async () => undefined),
        deleteLocal: vi.fn(async () => undefined),
        ...over,
    };
}

describe('applyOp batch push', () => {
    it('calls pushBlobs once with all push ops', async () => {
        const pushBlobs = vi.fn(async () => undefined);
        const pushBlob = vi.fn(async () => undefined);
        const ops: ApplyOp[] = [
            { id: 'a', kind: 'push_blob', type: 'worldinfo', hash: 'h1' },
            { id: 'b', kind: 'push_blob', type: 'chat', hash: 'h2' },
            { id: 'c', kind: 'pull_blob', type: 'preset', hash: 'h3' },
        ];
        const result = await applyOp(ops, baseCtx({ pushBlobs, pushBlob }));
        expect(pushBlobs).toHaveBeenCalledOnce();
        expect(pushBlobs).toHaveBeenCalledWith([
            { id: 'a', hash: 'h1' },
            { id: 'b', hash: 'h2' },
        ]);
        expect(pushBlob).not.toHaveBeenCalled();
        expect(result.done).toBe(3);
    });

    it('falls back to parallel pushBlob when pushBlobs omitted', async () => {
        const pushBlob = vi.fn(async () => undefined);
        const ops: ApplyOp[] = [
            { id: 'a', kind: 'push_blob', type: 'worldinfo', hash: 'h1' },
            { id: 'b', kind: 'push_blob', type: 'chat', hash: 'h2' },
        ];
        await applyOp(ops, baseCtx({ pushBlob, concurrency: 2 }));
        expect(pushBlob).toHaveBeenCalledTimes(2);
    });

    it('runs pulls of the same type in parallel (concurrency)', async () => {
        let inflight = 0;
        let maxInflight = 0;
        const pullAndApply = vi.fn(async () => {
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            await new Promise((r) => setTimeout(r, 20));
            inflight--;
        });
        const ops: ApplyOp[] = [
            { id: 'c1', kind: 'pull_blob', type: 'chat', hash: 'h1' },
            { id: 'c2', kind: 'pull_blob', type: 'chat', hash: 'h2' },
            { id: 'c3', kind: 'pull_blob', type: 'chat', hash: 'h3' },
        ];
        await applyOp(ops, baseCtx({ pullAndApply, concurrency: 3 }));
        expect(pullAndApply).toHaveBeenCalledTimes(3);
        expect(maxInflight).toBeGreaterThan(1);
    });

    it('calls deleteLocal for delete_local ops', async () => {
        const deleteLocal = vi.fn(async () => undefined);
        const ops: ApplyOp[] = [
            { id: 'chat/A.png/old', kind: 'delete_local', type: 'chat' },
            { id: 'chat/A.png/new', kind: 'pull_blob', type: 'chat', hash: 'h2' },
        ];
        const result = await applyOp(ops, baseCtx({ deleteLocal }));
        expect(deleteLocal).toHaveBeenCalledWith('chat/A.png/old', 'chat');
        expect(result.done).toBe(2);
    });
});
