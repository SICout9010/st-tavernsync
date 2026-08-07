import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setGenerationBusy, isGenerationBusy } from '../engine';

describe('generation lock', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        setGenerationBusy(false);
    });

    afterEach(() => {
        setGenerationBusy(false);
        vi.useRealTimers();
    });

    it('is idle by default', () => {
        expect(isGenerationBusy()).toBe(false);
    });

    it('locks while generating and clears when it ends', () => {
        setGenerationBusy(true);
        expect(isGenerationBusy()).toBe(true);
        setGenerationBusy(false);
        expect(isGenerationBusy()).toBe(false);
    });

    it('stays locked below the max lock age', () => {
        setGenerationBusy(true);
        vi.advanceTimersByTime(4 * 60_000);
        expect(isGenerationBusy()).toBe(true);
    });

    // Guards the bug this fixes: a lost "generation ended" event used to wedge
    // sync permanently, and a page reload did not clear it.
    it('self-heals when no end event arrives within the max lock age', () => {
        setGenerationBusy(true);
        vi.advanceTimersByTime(5 * 60_000);
        expect(isGenerationBusy()).toBe(false);
    });

    it('can lock again after self-healing', () => {
        setGenerationBusy(true);
        vi.advanceTimersByTime(6 * 60_000);
        expect(isGenerationBusy()).toBe(false);
        setGenerationBusy(true);
        expect(isGenerationBusy()).toBe(true);
    });
});
