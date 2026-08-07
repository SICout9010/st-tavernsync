/**
 * Speed + peak-memory comparison: eager prepare-all vs lazy load-in-worker.
 *
 * Run: npm test -- src/backend/__tests__/uploadBlobsParallel.speed.test.ts
 */
import { describe, expect, it } from 'vitest';
import type { StorageAdapter } from '../adapter';
import type { Manifest } from '../../sync-core/types';
import { uploadBlobsParallel } from '../http';
import { mapPool } from '../../util/pool';

const FILE_COUNT = 24;
const FILE_BYTES = 2 * 1024 * 1024; // 2 MiB each → 48 MiB total payload
const LOAD_MS = 25; // simulated IndexedDB + encrypt
const PUT_MS = 40; // simulated network PUT
const CONCURRENCY = 4;

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function makePayload(hash: string, size: number): Uint8Array {
    const buf = new Uint8Array(size);
    const seed = hash.charCodeAt(0) || 1;
    for (let i = 0; i < size; i += 4096) buf[i] = (seed + i) & 0xff;
    return buf;
}

class MemAdapter implements StorageAdapter {
    store = new Map<string, Uint8Array>();
    putCalls = 0;

    async getManifest() {
        return { manifest: null, version: 0 };
    }
    async putManifest(_m: Manifest, _ifVersion: number) {
        return { version: 1 };
    }
    async checkBlobs(hashes: string[]) {
        return hashes.filter((h) => !this.store.has(h));
    }
    async getBlob(hash: string) {
        const b = this.store.get(hash);
        if (!b) throw new Error(`getBlob ${hash}: 404`);
        return b;
    }
    async putBlob(hash: string, data: Uint8Array) {
        await sleep(PUT_MS);
        this.putCalls++;
        this.store.set(hash, data);
    }
    async quota() {
        return { usedBytes: 0, limitBytes: 0, itemCount: 0 };
    }
}

class PeakTracker {
    current = 0;
    peak = 0;
    hold(bytes: number) {
        this.current += bytes;
        if (this.current > this.peak) this.peak = this.current;
    }
    release(bytes: number) {
        this.current -= bytes;
    }
}

/** Wrap adapter so peak is released when putBlob finishes. */
function trackPuts(adapter: MemAdapter, peak: PeakTracker, held: Map<string, number>): StorageAdapter {
    return {
        getManifest: () => adapter.getManifest(),
        putManifest: (m, v) => adapter.putManifest(m, v),
        checkBlobs: (h) => adapter.checkBlobs(h),
        getBlob: (h) => adapter.getBlob(h),
        quota: () => adapter.quota(),
        async putBlob(hash, data) {
            try {
                await adapter.putBlob(hash, data);
            } finally {
                const n = held.get(hash) ?? data.byteLength;
                peak.release(n);
                held.delete(hash);
            }
        },
    };
}

async function eagerUpload(
    adapter: StorageAdapter,
    hashes: string[],
    load: (hash: string) => Promise<Uint8Array>,
    concurrency: number,
    peak: PeakTracker,
): Promise<void> {
    // Old shape: prepare ALL data first (peak = full batch), then upload
    const prepared = await mapPool(hashes, concurrency, async (hash) => {
        const data = await load(hash);
        peak.hold(data.byteLength);
        return { hash, data };
    });
    const missing = await adapter.checkBlobs(prepared.map((e) => e.hash));
    const need = new Set(missing);
    const queue = prepared.filter((e) => need.has(e.hash));
    await mapPool(queue, concurrency, async (entry) => {
        await adapter.putBlob(entry.hash, entry.data);
        peak.release(entry.data.byteLength);
    });
}

describe('uploadBlobsParallel speed (eager vs lazy)', () => {
    it(`uploads ${FILE_COUNT}×${FILE_BYTES / 1024 / 1024}MiB: lazy ≃ speed, much lower peak RAM`, async () => {
        const hashes = Array.from({ length: FILE_COUNT }, (_, i) => `h${i.toString(16).padStart(8, '0')}`);
        const cache = new Map(hashes.map((h) => [h, makePayload(h, FILE_BYTES)]));

        const load = async (hash: string) => {
            await sleep(LOAD_MS);
            return cache.get(hash)!;
        };

        // --- eager (old: prepare all, then upload) ---
        const eagerInner = new MemAdapter();
        const eagerPeak = new PeakTracker();
        const t0 = performance.now();
        await eagerUpload(eagerInner, hashes, load, CONCURRENCY, eagerPeak);
        const eagerMs = performance.now() - t0;

        // --- lazy (production uploadBlobsParallel) ---
        const lazyInner = new MemAdapter();
        const lazyPeak = new PeakTracker();
        const held = new Map<string, number>();
        const lazyAdapter = trackPuts(lazyInner, lazyPeak, held);
        const t1 = performance.now();
        await uploadBlobsParallel(
            lazyAdapter,
            hashes,
            async (hash) => {
                const data = await load(hash);
                lazyPeak.hold(data.byteLength);
                held.set(hash, data.byteLength);
                return data;
            },
            CONCURRENCY,
        );
        const lazyMs = performance.now() - t1;

        const eagerPeakMiB = eagerPeak.peak / 1024 / 1024;
        const lazyPeakMiB = lazyPeak.peak / 1024 / 1024;
        const totalMiB = (FILE_COUNT * FILE_BYTES) / 1024 / 1024;

        // eslint-disable-next-line no-console
        console.log('\n[uploadBlobsParallel speed]');
        // eslint-disable-next-line no-console
        console.log(`  files: ${FILE_COUNT} × ${FILE_BYTES / 1024 / 1024} MiB = ${totalMiB} MiB total`);
        // eslint-disable-next-line no-console
        console.log(`  concurrency: ${CONCURRENCY}, load=${LOAD_MS}ms, put=${PUT_MS}ms (simulated)`);
        // eslint-disable-next-line no-console
        console.log(`  eager: ${eagerMs.toFixed(0)} ms, peak held ≈ ${eagerPeakMiB.toFixed(1)} MiB, puts=${eagerInner.putCalls}`);
        // eslint-disable-next-line no-console
        console.log(`  lazy:  ${lazyMs.toFixed(0)} ms, peak held ≈ ${lazyPeakMiB.toFixed(1)} MiB, puts=${lazyInner.putCalls}`);
        // eslint-disable-next-line no-console
        console.log(`  peak ratio lazy/eager: ${(lazyPeakMiB / Math.max(eagerPeakMiB, 0.001)).toFixed(2)}`);
        // eslint-disable-next-line no-console
        console.log(`  time ratio lazy/eager: ${(lazyMs / Math.max(eagerMs, 0.001)).toFixed(2)}`);

        expect(eagerInner.putCalls).toBe(FILE_COUNT);
        expect(lazyInner.putCalls).toBe(FILE_COUNT);

        // Eager holds the whole prepared batch before puts drain it.
        expect(eagerPeak.peak).toBeGreaterThanOrEqual(FILE_COUNT * FILE_BYTES);
        // Lazy peak ≈ concurrency × file size
        expect(lazyPeak.peak).toBeLessThanOrEqual((CONCURRENCY + 1) * FILE_BYTES);
        expect(lazyPeak.peak).toBeLessThan(eagerPeak.peak / 2);

        // Lazy pipelines load∥put — should not be meaningfully slower (25% slack for CI jitter).
        expect(lazyMs).toBeLessThan(eagerMs * 1.25);
    }, 60_000);

    it('skips checkBlobs hits and dedupes hashes', async () => {
        const adapter = new MemAdapter();
        const already = makePayload('aa', 64);
        await adapter.putBlob('aa', already);
        adapter.putCalls = 0;

        let loads = 0;
        await uploadBlobsParallel(
            adapter,
            ['aa', 'bb', 'bb', 'cc'],
            async (hash) => {
                loads++;
                return makePayload(hash, 64);
            },
            4,
        );

        expect(loads).toBe(2); // bb, cc only
        expect(adapter.putCalls).toBe(2);
        expect(adapter.store.has('bb')).toBe(true);
        expect(adapter.store.has('cc')).toBe(true);
    });
});
