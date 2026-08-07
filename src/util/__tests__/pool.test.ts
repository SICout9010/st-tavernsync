import { describe, expect, it } from 'vitest';
import { mapPool } from '../pool';

describe('mapPool', () => {
    it('caps concurrency', async () => {
        let inflight = 0;
        let max = 0;
        const items = [1, 2, 3, 4, 5, 6];
        const out = await mapPool(items, 2, async (n) => {
            inflight++;
            max = Math.max(max, inflight);
            await new Promise((r) => setTimeout(r, 15));
            inflight--;
            return n * 10;
        });
        expect(out).toEqual([10, 20, 30, 40, 50, 60]);
        expect(max).toBeLessThanOrEqual(2);
        expect(max).toBe(2);
    });

    it('returns empty for empty input', async () => {
        expect(await mapPool([], 4, async (x) => x)).toEqual([]);
    });
});
