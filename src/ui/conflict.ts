import type { DiffEntry } from '../sync-core/types';
import type { ConflictChoice } from '../sync/engine';

/**
 * Conflict popup — Keep local / Keep remote / Keep both.
 * Uses SillyTavern Popup when available; otherwise defaults to keep both.
 */
export async function promptConflict(entry: DiffEntry): Promise<ConflictChoice> {
    const ctx = SillyTavern.getContext() as SillyTavernContext & {
        Popup?: {
            show: {
                text: (message: string, title?: string) => Promise<unknown>;
            };
        };
        callGenericPopup?: (
            content: string | HTMLElement,
            type?: number,
            inputValue?: string,
            options?: Record<string, unknown>,
        ) => Promise<unknown>;
        POPUP_TYPE?: { TEXT?: number; CONFIRM?: number };
    };

    const sizeL = entry.local?.size ?? 0;
    const sizeR = entry.remote?.size ?? 0;
    const mtimeL = entry.local?.mtime ?? 0;
    const mtimeR = entry.remote?.mtime ?? 0;
    const html = `
      <div class="tavernsync-conflict">
        <p><b>Same item changed on both sides</b></p>
        <p><code>${escapeHtml(entry.id)}</code></p>
        <p>This device: ${formatBytes(sizeL)}${mtimeL ? `, updated ${new Date(mtimeL).toLocaleString()}` : ''}<br/>
           Server: ${formatBytes(sizeR)}${mtimeR ? `, updated ${new Date(mtimeR).toLocaleString()}` : ''}</p>
        <label><input type="radio" name="ts_conflict" value="local" /> Keep this device's version</label><br/>
        <label><input type="radio" name="ts_conflict" value="remote" /> Keep the server's version</label><br/>
        <label><input type="radio" name="ts_conflict" value="both" checked /> Keep both (safest)</label>
      </div>`;

    if (typeof ctx.callGenericPopup === 'function') {
        const type = ctx.POPUP_TYPE?.CONFIRM ?? 1;
        const result = await ctx.callGenericPopup(html, type);
        if (!result) return 'both';
        const selected = document.querySelector('input[name="ts_conflict"]:checked') as HTMLInputElement | null;
        const v = selected?.value;
        if (v === 'local' || v === 'remote' || v === 'both') return v;
        return 'both';
    }

    // Fallback: window.prompt
    const ans = window.prompt(
        `Conflict on ${entry.id}\nType: local | remote | both\n(default both)`,
        'both',
    );
    if (ans === 'local' || ans === 'remote' || ans === 'both') return ans;
    return 'both';
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBytes(n: number): string {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Batch: ask once whether to keep both for everything. */
export async function promptConflicts(entries: DiffEntry[]): Promise<Map<string, ConflictChoice>> {
    const map = new Map<string, ConflictChoice>();
    if (!entries.length) return map;

    const allBoth = window.confirm(
        `${entries.length} item(s) changed on both this device and the server.\n\nOK = keep both copies for all of them\nCancel = choose one by one`,
    );
    if (allBoth) {
        for (const e of entries) map.set(e.id, 'both');
        return map;
    }
    for (const e of entries) {
        map.set(e.id, await promptConflict(e));
    }
    return map;
}
