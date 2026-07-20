/**
 * Orchestrates scan → diff → plan → push/pull with optional E2EE.
 */

import { ConflictError } from '../backend/adapter';
import { HttpStorageAdapter, uploadBlobsParallel } from '../backend/http';
import { decodeSalt, deriveKey, encodeSalt, hmacBlobKey, open, seal } from '../crypto';
import { LOG_PREFIX, getSettings, saveSettings, type SyncScopeSettings } from '../settings';
import { loadBlob, loadLocalManifest, scanLocal, storeBlob } from '../st-adapter/scan';
import { applyLocalItem, decodeUtf8Jsonl, parseItemId, writeChat } from '../st-adapter/write';
import { stFetchJson } from '../st-adapter/http';
import { conflictSiblingId, tryChatFastForward } from '../sync-core/conflict';
import { diffManifests, summarizeDiff } from '../sync-core/diff';
import { applyOp } from '../sync-core/apply';
import { buildPlan } from '../sync-core/plan';
import { mergeSettingsThreeWay, sha256Hex } from '../st-adapter/normalize';
import type { DiffEntry, Manifest, SyncItem } from '../sync-core/types';
import { emptyManifest } from '../sync-core/types';
import { BASE_KEY, getSyncStore } from '../state/store';

export interface BaseState {
    manifest: Manifest;
    syncedAt: number;
    remoteVersion: number;
}

export type ConflictChoice = 'local' | 'remote' | 'both';

let sessionKey: CryptoKey | null = null;
let sessionPassphrase: string | null = null;
let generating = false;

export function setGenerationBusy(busy: boolean): void {
    generating = busy;
}

export function isGenerationBusy(): boolean {
    return generating;
}

export async function loadBase(): Promise<BaseState | null> {
    return getSyncStore().getItem<BaseState>(BASE_KEY);
}

export async function saveBase(state: BaseState): Promise<void> {
    await getSyncStore().setItem(BASE_KEY, state);
}

export async function clearBase(): Promise<void> {
    await getSyncStore().removeItem(BASE_KEY);
}

/**
 * E2EE salt must be per-account (shared), not per-device.
 * Otherwise HMAC blob keys differ and pulls 404.
 */
export async function syncAccountSalt(passphrase?: string): Promise<void> {
    const s = getSettings();
    if (!s.e2eeEnabled) return;
    if (!s.endpoint.trim() || !s.deviceToken.trim()) return;

    const adapter = requireAdapter();
    let localSalt = s.e2eeSalt;
    if (!localSalt) {
        // Need a salt to publish — create one if unlocking
        if (!passphrase && !sessionPassphrase) return;
        const { salt } = await deriveKey(passphrase || sessionPassphrase || '');
        localSalt = encodeSalt(salt);
        s.e2eeSalt = localSalt;
        saveSettings();
    }

    const canonical = await adapter.ensureAccountSalt(localSalt);
    if (canonical !== s.e2eeSalt) {
        console.warn(LOG_PREFIX, 'Adopting account E2EE salt from server (was device-local)');
        s.e2eeSalt = canonical;
        saveSettings();
        const pw = passphrase || sessionPassphrase;
        if (pw) {
            const { key } = await deriveKey(pw, decodeSalt(canonical));
            sessionKey = key;
        } else {
            // Salt changed — force re-unlock
            sessionKey = null;
            console.warn(LOG_PREFIX, 'Re-unlock E2EE passphrase after adopting server salt');
        }
    }
}

export async function unlockE2ee(passphrase: string): Promise<void> {
    const s = getSettings();
    sessionPassphrase = passphrase;

    // Prefer account salt from server when available
    if (s.endpoint.trim() && s.deviceToken.trim()) {
        try {
            const adapter = requireAdapter();
            const { e2eeSalt } = await adapter.getAccount();
            if (e2eeSalt) {
                s.e2eeSalt = e2eeSalt;
                saveSettings();
            }
        } catch (e) {
            console.warn(LOG_PREFIX, 'Could not fetch account salt', e);
        }
    }

    let salt: Uint8Array;
    if (s.e2eeSalt) {
        salt = decodeSalt(s.e2eeSalt);
        const { key } = await deriveKey(passphrase, salt);
        sessionKey = key;
    } else {
        const { key, salt: newSalt } = await deriveKey(passphrase);
        sessionKey = key;
        s.e2eeSalt = encodeSalt(newSalt);
        saveSettings();
    }

    try {
        await syncAccountSalt(passphrase);
    } catch (e) {
        console.warn(LOG_PREFIX, 'syncAccountSalt after unlock failed', e);
    }
}

export function lockE2ee(): void {
    sessionKey = null;
    sessionPassphrase = null;
}

export function hasE2eeKey(): boolean {
    return !!sessionKey;
}

function scopeTypeSet(scope: SyncScopeSettings): Set<string> {
    const map: Record<string, string> = {
        settings: 'settings',
        characters: 'character',
        chats: 'chat',
        lorebooks: 'worldinfo',
        presets: 'preset',
        personas: 'persona',
        groups: 'group',
        quickreplies: 'quickreply',
        themes: 'theme',
    };
    const set = new Set<string>();
    for (const [k, on] of Object.entries(scope)) {
        if (on && map[k]) {
            set.add(map[k]);
            if (k === 'groups') set.add('groupchat');
        }
    }
    return set;
}

function requireAdapter(): HttpStorageAdapter {
    const s = getSettings();
    if (!s.endpoint.trim()) throw new Error('No endpoint configured');
    if (!s.deviceToken.trim()) throw new Error('No device token configured');
    return new HttpStorageAdapter({ endpoint: s.endpoint.trim(), deviceToken: s.deviceToken.trim() });
}

async function blobStorageKey(plaintextHash: string): Promise<string> {
    const s = getSettings();
    if (!s.e2eeEnabled || !s.e2eeSalt) return plaintextHash;
    return hmacBlobKey(decodeSalt(s.e2eeSalt), plaintextHash);
}

/** Try HMAC key first (E2EE), then plaintext hash (legacy / non-E2EE uploads). */
async function getRemoteBlob(adapter: HttpStorageAdapter, plaintextHash: string): Promise<Uint8Array> {
    const key = await blobStorageKey(plaintextHash);
    try {
        return await adapter.getBlob(key);
    } catch (e) {
        if (key !== plaintextHash) {
            console.warn(LOG_PREFIX, `Blob ${key} missing; trying plaintext hash ${plaintextHash}`);
            return await adapter.getBlob(plaintextHash);
        }
        throw e;
    }
}

async function maybeEncrypt(bytes: Uint8Array): Promise<Uint8Array> {
    const s = getSettings();
    if (!s.e2eeEnabled) return bytes;
    if (!sessionKey) throw new Error('E2EE enabled but passphrase not unlocked this session');
    return seal(sessionKey, bytes);
}

async function maybeDecrypt(bytes: Uint8Array, expectedHash: string): Promise<Uint8Array> {
    const s = getSettings();
    let plain = bytes;
    if (s.e2eeEnabled) {
        if (!sessionKey) throw new Error('E2EE enabled but passphrase not unlocked this session');
        plain = await open(sessionKey, bytes);
    }
    const hash = await sha256Hex(plain);
    if (hash !== expectedHash) {
        throw new Error(`Blob hash mismatch: expected ${expectedHash}, got ${hash}`);
    }
    return plain;
}

export async function runScan(onProgress?: (m: string) => void) {
    const s = getSettings();
    return scanLocal({
        deviceName: s.deviceName || 'device',
        scope: s.scope,
        onProgress,
    });
}

export async function getStatusDiff(): Promise<{
    local: Manifest;
    remote: Manifest | null;
    base: Manifest | null;
    remoteVersion: number;
    entries: DiffEntry[];
    summary: ReturnType<typeof summarizeDiff>;
    itemCount: number;
}> {
    let local = await loadLocalManifest();
    if (!local) {
        const scanned = await runScan();
        local = scanned.manifest;
    }

    let remote: Manifest | null = null;
    let remoteVersion = 0;
    try {
        const adapter = requireAdapter();
        const got = await adapter.getManifest();
        remote = got.manifest;
        remoteVersion = got.version;
    } catch (e) {
        console.warn(LOG_PREFIX, 'Remote unavailable for status', e);
    }

    const baseState = await loadBase();
    const entries = diffManifests(local, baseState?.manifest ?? null, remote);
    return {
        local,
        remote,
        base: baseState?.manifest ?? null,
        remoteVersion,
        entries,
        summary: summarizeDiff(entries),
        itemCount: Object.keys(local.items).length,
    };
}

async function resolveChatConflict(
    id: string,
    localHash: string,
    remoteHash: string,
    adapter: HttpStorageAdapter,
): Promise<'local' | 'remote' | 'both' | 'fast_forward_local' | 'fast_forward_remote'> {
    let localBytes = await loadBlob(localHash);
    if (!localBytes || localBytes.byteLength === 0) {
        // re-scan needed; treat as both
        return 'both';
    }
    const remoteBoxed = await getRemoteBlob(adapter, remoteHash);
    const remoteBytes = await maybeDecrypt(remoteBoxed, remoteHash);
    const localMsgs = decodeUtf8Jsonl(localBytes);
    const remoteMsgs = decodeUtf8Jsonl(remoteBytes);
    const ff = tryChatFastForward(localMsgs, remoteMsgs);
    if (ff.kind === 'same') return 'local';
    if (ff.kind === 'fast_forward') {
        return ff.winner === 'local' ? 'fast_forward_local' : 'fast_forward_remote';
    }
    return 'both';
}

export interface SyncRunOptions {
    direction: 'push' | 'pull' | 'both';
    dryRun?: boolean;
    /** Restrict to these types (M4 lorebooks+presets dogfood) */
    typeFilter?: Set<string>;
    onProgress?: (m: string) => void;
    resolveConflict?: (entry: DiffEntry) => Promise<ConflictChoice>;
}

export async function runSync(opts: SyncRunOptions): Promise<{ message: string }> {
    if (isGenerationBusy()) {
        throw new Error('Cannot sync while generation is in progress');
    }

    const s = getSettings();
    if (s.e2eeEnabled) {
        await syncAccountSalt();
        if (!sessionKey) {
            throw new Error('E2EE enabled but passphrase not unlocked this session');
        }
    }
    const adapter = requireAdapter();
    const progress = (m: string) => {
        opts.onProgress?.(m);
        console.log(LOG_PREFIX, m);
    };

    progress('Scanning local…');
    const scanned = await runScan(progress);
    const local = scanned.manifest;

    progress('Fetching remote manifest…');
    let { manifest: remote, version: remoteVersion } = await adapter.getManifest();
    const baseState = await loadBase();

    let entries = diffManifests(local, baseState?.manifest ?? null, remote);
    const allowed = opts.typeFilter || scopeTypeSet(s.scope);

    // Pre-resolve chat conflicts via fast-forward
    for (const e of entries) {
        if (e.action !== 'conflict' || e.type !== 'chat') continue;
        if (!e.local || !e.remote) continue;
        try {
            const decision = await resolveChatConflict(e.id, e.local.hash, e.remote.hash, adapter);
            if (decision === 'fast_forward_remote') {
                e.action = 'pull';
            } else if (decision === 'fast_forward_local') {
                e.action = 'push';
            }
        } catch (err) {
            console.error(LOG_PREFIX, 'fast-forward check failed', e.id, err);
        }
    }

    // User conflict resolution for remaining conflicts
    for (const e of entries) {
        if (e.action !== 'conflict') continue;
        if (e.type === 'settings' && e.local && e.remote) {
            // Field-level merge attempt
            try {
                const localBytes = await loadBlob(e.local.hash);
                const remoteBoxed = await getRemoteBlob(adapter, e.remote.hash);
                const remoteBytes = await maybeDecrypt(remoteBoxed, e.remote.hash);
                const localObj = JSON.parse(new TextDecoder().decode(localBytes!)) as Record<string, unknown>;
                const remoteObj = JSON.parse(new TextDecoder().decode(remoteBytes)) as Record<string, unknown>;
                let baseObj: Record<string, unknown> | null = null;
                if (e.base) {
                    const bb = await loadBlob(e.base.hash);
                    if (bb) baseObj = JSON.parse(new TextDecoder().decode(bb)) as Record<string, unknown>;
                }
                const { merged, conflicts } = mergeSettingsThreeWay(localObj, baseObj, remoteObj);
                if (conflicts.length === 0) {
                    const json = JSON.stringify(merged); // already from merge of stripped trees
                    const bytes = new TextEncoder().encode(json);
                    const hash = await sha256Hex(bytes);
                    await storeBlob(hash, bytes);
                    local.items[e.id] = { ...e.local, hash, size: bytes.byteLength };
                    e.action = 'push';
                    e.local = local.items[e.id];
                    continue;
                }
            } catch (err) {
                console.error(LOG_PREFIX, 'settings merge failed', err);
            }
        }

        const choice = opts.resolveConflict
            ? await opts.resolveConflict(e)
            : 'both';
        if (choice === 'local') e.action = 'push';
        else if (choice === 'remote') e.action = 'pull';
        // both stays conflict → keep_both in plan
    }

    if (opts.direction === 'push') {
        entries = entries.filter((e) =>
            e.action === 'push' || e.action === 'push_new' || e.action === 'local_delete' || e.action === 'conflict');
    } else if (opts.direction === 'pull') {
        entries = entries.filter((e) =>
            e.action === 'pull' || e.action === 'pull_new' || e.action === 'remote_delete' || e.action === 'conflict');
    }

    const plan = buildPlan(entries, {
        propagateDeletes: s.propagateDeletes,
        allowedTypes: allowed,
    });

    progress(`Plan: ${plan.length} ops`);

    let settingsChanged = false;

    await applyOp(plan, {
        dryRun: !!opts.dryRun,
        log: (msg, meta) => console.log(LOG_PREFIX, msg, meta ?? ''),
        pushBlob: async (id, hash) => {
            let data = await loadBlob(hash);
            if (!data || data.byteLength === 0) {
                throw new Error(`Missing local blob for ${id} (${hash})`);
            }
            data = await maybeEncrypt(data);
            const key = await blobStorageKey(hash);
            await uploadBlobsParallel(adapter, [{ hash: key, data }]);
        },
        pullAndApply: async (id, type, hash) => {
            const boxed = await getRemoteBlob(adapter, hash);
            const plain = await maybeDecrypt(boxed, hash);
            await storeBlob(hash, plain);
            if (type === 'settings') {
                settingsChanged = true;
                // Merge pulled stripped settings into live settings carefully
                const pulled = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
                const live = { ...SillyTavern.getContext().extensionSettings } as unknown as Record<string, unknown>;
                // Better: fetch full settings, merge pulled keys onto live file
                const raw = await stFetchJson<{ settings: string }>('/api/settings/get', {});
                const full = JSON.parse(raw.settings || '{}') as Record<string, unknown>;
                const merged = { ...full, ...pulled };
                // Preserve local tavernsync settings
                if (!merged.extensionSettings) merged.extensionSettings = {};
                (merged.extensionSettings as Record<string, unknown>).tavernsync =
                    (full.extensionSettings as Record<string, unknown>)?.tavernsync
                    ?? getSettings();
                await applyLocalItem(id, type, new TextEncoder().encode(JSON.stringify(merged)), !!opts.dryRun);
            } else {
                await applyLocalItem(id, type, plain, !!opts.dryRun);
            }
        },
        keepBoth: async (id, type) => {
            const entry = entries.find((x) => x.id === id);
            if (!entry?.remote) return;
            const sibling = conflictSiblingId(id, s.deviceName || 'remote');
            const boxed = await getRemoteBlob(adapter, entry.remote.hash);
            const plain = await maybeDecrypt(boxed, entry.remote.hash);
            await storeBlob(entry.remote.hash, plain);

            if (type === 'chat') {
                const { parts } = parseItemId(sibling);
                const avatar = parts[0];
                const fileName = parts.slice(1).join('/');
                const chat = decodeUtf8Jsonl(plain);
                if (!opts.dryRun) await writeChat(avatar, fileName, chat, true);
            } else {
                await applyLocalItem(sibling, type, plain, !!opts.dryRun);
            }
            toastr.warning(`Kept both copies for ${id}`, 'TavernSync');
        },
        tombstone: async (id) => {
            // Mark deleted on remote by pushing manifest without item — handled by rebuild below
            console.log(LOG_PREFIX, 'tombstone', id);
        },
    });

    // Rebuild remote manifest from intended end state
    if (!opts.dryRun && (opts.direction === 'push' || opts.direction === 'both')) {
        progress('Committing remote manifest…');
        const newItems: Record<string, SyncItem> = { ...(remote?.items || {}) };
        for (const e of entries) {
            if (!allowed.has(e.type || '')) continue;
            if (e.action === 'push' || e.action === 'push_new') {
                if (e.local) newItems[e.id] = e.local;
            }
            if (e.action === 'pull' || e.action === 'pull_new') {
                if (e.remote) newItems[e.id] = e.remote;
            }
            if (e.action === 'local_delete' && s.propagateDeletes) {
                delete newItems[e.id];
            }
        }

        // Drop entries whose blobs are missing under both HMAC key and plaintext hash
        const dropped: string[] = [];
        for (const [id, item] of Object.entries(newItems)) {
            const keyed = await blobStorageKey(item.hash);
            const missing = await adapter.checkBlobs(
                keyed === item.hash ? [item.hash] : [keyed, item.hash],
            );
            const hasBlob = keyed === item.hash
                ? !missing.includes(item.hash)
                : !(missing.includes(keyed) && missing.includes(item.hash));
            if (!hasBlob) {
                delete newItems[id];
                dropped.push(id);
            }
        }
        if (dropped.length) {
            console.error(LOG_PREFIX, 'Dropping manifest entries with missing blobs', dropped);
            toastr.warning(
                `${dropped.length} item(s) not published — blob missing on server. Unlock + Push again.`,
                'TavernSync',
            );
        }

        const newManifest: Manifest = {
            ...emptyManifest(s.deviceName || 'device', remoteVersion),
            items: newItems,
            updatedAt: Date.now(),
        };

        try {
            const { version } = await adapter.putManifest(newManifest, remoteVersion);
            await saveBase({ manifest: newManifest, syncedAt: Date.now(), remoteVersion: version });
        } catch (err) {
            if (err instanceof ConflictError) {
                progress('412 conflict — re-diff once…');
                const again = await adapter.getManifest();
                remote = again.manifest;
                remoteVersion = again.version;
                throw new Error('Remote changed during push; please retry');
            }
            throw err;
        }
    } else if (!opts.dryRun && opts.direction === 'pull') {
        // After successful pull, base = remote
        if (remote) {
            await saveBase({ manifest: remote, syncedAt: Date.now(), remoteVersion });
        }
    }

    const summary = summarizeDiff(entries);
    const message = `${summary.push} push · ${summary.pull} pull · ${summary.conflict} conflict`;
    s.lastStatusMessage = message;
    saveSettings();

    if (settingsChanged) {
        toastr.info('Settings were pulled. Reload recommended.', 'TavernSync');
        // Soft prompt — don't force
        if (confirm('TavernSync pulled settings. Reload the page now?')) {
            location.reload();
        }
    }

    return { message };
}
