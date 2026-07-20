import type { Manifest } from '../sync-core/types';

export class ConflictError extends Error {
    constructor(message = 'Manifest version conflict') {
        super(message);
        this.name = 'ConflictError';
    }
}

export interface StorageAdapter {
    getManifest(): Promise<{ manifest: Manifest | null; version: number }>;
    putManifest(m: Manifest, ifVersion: number): Promise<{ version: number }>;
    checkBlobs(hashes: string[]): Promise<string[]>;
    getBlob(hash: string): Promise<Uint8Array>;
    putBlob(hash: string, data: Uint8Array): Promise<void>;
    quota(): Promise<{ usedBytes: number; limitBytes: number; itemCount: number }>;
}
