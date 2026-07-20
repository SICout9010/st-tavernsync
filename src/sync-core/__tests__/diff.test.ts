import { describe, expect, it } from 'vitest';
import { conflictSiblingId, tryChatFastForward } from '../conflict';
import { diffManifests, summarizeDiff } from '../diff';
import { buildPlan } from '../plan';
import { emptyManifest, type Manifest, type SyncItem } from '../types';

function item(id: string, hash: string, type: SyncItem['type'] = 'worldinfo'): SyncItem {
    return { id, type, hash, size: 1, mtime: 1 };
}

function manifest(items: Record<string, SyncItem>, version = 1): Manifest {
    return { ...emptyManifest('test'), version, items };
}

describe('diffManifests', () => {
    it('in_sync when hashes match', () => {
        const m = manifest({ 'worldinfo/a': item('worldinfo/a', 'h1') });
        const d = diffManifests(m, m, m);
        expect(d[0].action).toBe('in_sync');
    });

    it('push when local changed vs base==remote', () => {
        const base = manifest({ 'worldinfo/a': item('worldinfo/a', 'h0') });
        const local = manifest({ 'worldinfo/a': item('worldinfo/a', 'h1') });
        const remote = manifest({ 'worldinfo/a': item('worldinfo/a', 'h0') });
        expect(diffManifests(local, base, remote)[0].action).toBe('push');
    });

    it('pull when remote changed vs base==local', () => {
        const base = manifest({ 'worldinfo/a': item('worldinfo/a', 'h0') });
        const local = manifest({ 'worldinfo/a': item('worldinfo/a', 'h0') });
        const remote = manifest({ 'worldinfo/a': item('worldinfo/a', 'h2') });
        expect(diffManifests(local, base, remote)[0].action).toBe('pull');
    });

    it('conflict when both changed', () => {
        const base = manifest({ 'worldinfo/a': item('worldinfo/a', 'h0') });
        const local = manifest({ 'worldinfo/a': item('worldinfo/a', 'h1') });
        const remote = manifest({ 'worldinfo/a': item('worldinfo/a', 'h2') });
        expect(diffManifests(local, base, remote)[0].action).toBe('conflict');
    });

    it('push_new for local-only', () => {
        const local = manifest({ 'worldinfo/a': item('worldinfo/a', 'h1') });
        expect(diffManifests(local, null, null)[0].action).toBe('push_new');
    });

    it('pull_new for remote-only', () => {
        const remote = manifest({ 'worldinfo/a': item('worldinfo/a', 'h1') });
        const local = emptyManifest('x');
        expect(diffManifests(local, null, remote)[0].action).toBe('pull_new');
    });

    it('local_delete when gone locally but in base', () => {
        const base = manifest({ 'worldinfo/a': item('worldinfo/a', 'h0') });
        const local = emptyManifest('x');
        const remote = manifest({ 'worldinfo/a': item('worldinfo/a', 'h0') });
        expect(diffManifests(local, base, remote)[0].action).toBe('local_delete');
    });

    it('remote_delete when gone remotely but in base', () => {
        const base = manifest({ 'worldinfo/a': item('worldinfo/a', 'h0') });
        const local = manifest({ 'worldinfo/a': item('worldinfo/a', 'h0') });
        const remote = emptyManifest('x');
        expect(diffManifests(local, base, remote)[0].action).toBe('remote_delete');
    });
});

describe('summarizeDiff', () => {
    it('counts branches', () => {
        const s = summarizeDiff([
            { id: '1', action: 'push' },
            { id: '2', action: 'pull_new' },
            { id: '3', action: 'conflict' },
        ]);
        expect(s.push).toBe(1);
        expect(s.pull).toBe(1);
        expect(s.conflict).toBe(1);
    });
});

describe('tryChatFastForward', () => {
    const header = { chat_metadata: { integrity: 'x' }, user_name: 'unused', character_name: 'unused' };
    const m1 = { name: 'A', is_user: true, mes: 'hi', send_date: 1 };
    const m2 = { name: 'B', is_user: false, mes: 'yo', send_date: 2 };
    const m3 = { name: 'A', is_user: true, mes: 'again', send_date: 3 };

    it('fast-forwards when local is prefix of remote', () => {
        const r = tryChatFastForward([header, m1], [header, m1, m2]);
        expect(r.kind).toBe('fast_forward');
        if (r.kind === 'fast_forward') {
            expect(r.winner).toBe('remote');
            expect(r.messages).toHaveLength(3);
        }
    });

    it('fast-forwards when remote is prefix of local', () => {
        const r = tryChatFastForward([header, m1, m2, m3], [header, m1]);
        expect(r.kind).toBe('fast_forward');
        if (r.kind === 'fast_forward') expect(r.winner).toBe('local');
    });

    it('same when equal', () => {
        expect(tryChatFastForward([header, m1], [header, m1]).kind).toBe('same');
    });

    it('diverged when branches differ', () => {
        const other = { name: 'B', is_user: false, mes: 'nope', send_date: 2 };
        expect(tryChatFastForward([header, m1, m2], [header, m1, other]).kind).toBe('diverged');
    });
});

describe('conflictSiblingId', () => {
    it('suffixes chat ids', () => {
        const id = conflictSiblingId('chat/Alice.png/chat1', 'laptop', new Date('2026-07-20'));
        expect(id).toContain('conflict 2026-07-20');
        expect(id).toContain('laptop');
    });
});

describe('buildPlan', () => {
    it('maps push/pull/conflict and skips remote deletes', () => {
        const ops = buildPlan(
            [
                { id: 'a', action: 'push', type: 'worldinfo', local: item('a', 'h1') },
                { id: 'b', action: 'pull', type: 'preset', remote: item('b', 'h2', 'preset') },
                { id: 'c', action: 'conflict', type: 'chat', local: item('c', 'h1', 'chat'), remote: item('c', 'h2', 'chat') },
                { id: 'd', action: 'remote_delete', type: 'worldinfo', base: item('d', 'h0') },
            ],
            { propagateDeletes: false },
        );
        expect(ops.find((o) => o.id === 'a')?.kind).toBe('push_blob');
        expect(ops.find((o) => o.id === 'b')?.kind).toBe('pull_blob');
        expect(ops.find((o) => o.id === 'c')?.kind).toBe('keep_both');
        expect(ops.find((o) => o.id === 'd')?.kind).toBe('skip');
    });
});
