import type { DiffEntry } from '../sync-core/types';
import type { ConflictChoice } from '../sync/engine';

/**
 * Conflict popup — Keep local / Keep remote / Keep both / Skip.
 * Uses SillyTavern Popup when available.
 */
export async function promptConflict(
    entry: DiffEntry,
    preferred: ConflictChoice = 'skip',
): Promise<ConflictChoice> {
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
        <label><input type="radio" name="ts_conflict" value="skip" ${preferred === 'skip' ? 'checked' : ''} /> Skip (leave both as-is)</label><br/>
        <label><input type="radio" name="ts_conflict" value="local" ${preferred === 'local' ? 'checked' : ''} /> Keep this device's version</label><br/>
        <label><input type="radio" name="ts_conflict" value="remote" ${preferred === 'remote' ? 'checked' : ''} /> Keep the server's version</label><br/>
        <label><input type="radio" name="ts_conflict" value="both" ${preferred === 'both' ? 'checked' : ''} /> Keep both (extra copy)</label>
      </div>`;

    if (typeof ctx.callGenericPopup === 'function') {
        const type = ctx.POPUP_TYPE?.CONFIRM ?? 1;
        const result = await ctx.callGenericPopup(html, type);
        if (!result) return preferred;
        const selected = document.querySelector('input[name="ts_conflict"]:checked') as HTMLInputElement | null;
        const v = selected?.value;
        if (v === 'local' || v === 'remote' || v === 'both' || v === 'skip') return v;
        return preferred;
    }

    const ans = window.prompt(
        `Conflict on ${entry.id}\nType: skip | local | remote | both\n(default ${preferred})`,
        preferred,
    );
    if (ans === 'local' || ans === 'remote' || ans === 'both' || ans === 'skip') return ans;
    return preferred;
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

function preferredForDirection(direction: 'push' | 'pull' | 'both'): ConflictChoice {
    // Safe default: never mass-overwrite from a possibly incomplete device
    if (direction === 'pull') return 'remote';
    return 'skip';
}

/**
 * Ask once for a batch of conflicts.
 * Push → default = skip conflicts (safe). Force overwrite needs a second confirm.
 * Pull → default = take server for all (with warning).
 */
export async function promptConflicts(
    entries: DiffEntry[],
    direction: 'push' | 'pull' | 'both' = 'both',
): Promise<Map<string, ConflictChoice>> {
    const map = new Map<string, ConflictChoice>();
    if (!entries.length) return map;

    const preferred = preferredForDirection(direction);

    if (direction === 'push') {
        const skipSafe = window.confirm(
            `${entries.length} item(s) differ from the server.\n\n` +
            `If this device had a bad/incomplete Pull, overwriting the server can wipe good data on your other devices.\n\n` +
            `OK = Skip conflicts (safe) — only push non-conflicting items\n` +
            `Cancel = More options…`,
        );
        if (skipSafe) {
            for (const e of entries) map.set(e.id, 'skip');
            return map;
        }

        const force = window.confirm(
            `Force overwrite the SERVER with THIS device for all ${entries.length} conflict(s)?\n\n` +
            `Only OK if you are sure this device is the complete source of truth.\n\n` +
            `OK = Overwrite server\n` +
            `Cancel = Choose one by one`,
        );
        if (force) {
            for (const e of entries) map.set(e.id, 'local');
            return map;
        }
    } else if (direction === 'pull') {
        const useRemote = window.confirm(
            `${entries.length} item(s) differ from this device.\n\n` +
            `OK = Use the SERVER version for all of them\n` +
            `Cancel = Choose one by one`,
        );
        if (useRemote) {
            for (const e of entries) map.set(e.id, 'remote');
            return map;
        }
    } else {
        const skipSafe = window.confirm(
            `${entries.length} item(s) changed on both sides.\n\n` +
            `OK = Skip all for now (safe)\n` +
            `Cancel = Choose one by one`,
        );
        if (skipSafe) {
            for (const e of entries) map.set(e.id, 'skip');
            return map;
        }
    }

    for (const e of entries) {
        map.set(e.id, await promptConflict(e, preferred));
    }
    return map;
}
