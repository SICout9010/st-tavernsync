/** Shared sync data model (pure — no ST / DOM). */

export type ItemType =
    | 'settings'
    | 'preset'
    | 'worldinfo'
    | 'persona'
    | 'character'
    | 'chat'
    | 'group'
    | 'groupchat'
    | 'quickreply'
    | 'theme';

export interface SyncItem {
    id: string;
    type: ItemType;
    hash: string;
    size: number;
    mtime: number;
    deleted?: number;
}

export interface Manifest {
    version: number;
    schema: 1;
    device: string;
    updatedAt: number;
    items: Record<string, SyncItem>;
}

export type DiffAction =
    | 'in_sync'
    | 'push'
    | 'pull'
    | 'conflict'
    | 'push_new'
    | 'pull_new'
    | 'local_delete'
    | 'remote_delete';

export interface DiffEntry {
    id: string;
    action: DiffAction;
    type?: ItemType;
    local?: SyncItem;
    base?: SyncItem;
    remote?: SyncItem;
}

export type ApplyOpKind =
    | 'push_blob'
    | 'pull_blob'
    | 'apply_local'
    | 'tombstone'
    | 'keep_both'
    | 'skip';

export interface ApplyOp {
    id: string;
    kind: ApplyOpKind;
    type: ItemType;
    hash?: string;
    dryRun?: boolean;
    meta?: Record<string, unknown>;
}

export function emptyManifest(device: string, version = 0): Manifest {
    return {
        version,
        schema: 1,
        device,
        updatedAt: Date.now(),
        items: {},
    };
}
