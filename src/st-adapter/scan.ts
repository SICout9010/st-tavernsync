import type { SyncScopeSettings } from '../settings';
import { LOG_PREFIX } from '../settings';
import { emptyManifest, type Manifest, type SyncItem } from '../sync-core/types';
import { getSyncStore } from '../state/store';
import {
    fetchSettingsBundle,
    listCharacters,
    listChatsForCharacter,
    listGroups,
    listPersonas,
    listPresets,
    listQuickReplies,
    listThemes,
    listWorldInfo,
    makeSettingsItem,
    type ChatMetaCache,
} from './read';

const CACHE_KEY = 'tavernsync_chat_meta_cache';
const BLOB_PREFIX = 'blob:';
const LOCAL_MANIFEST_KEY = 'tavernsync_local_manifest';

export interface ScanResult {
    manifest: Manifest;
    itemCount: number;
    /** ids whose plaintext bytes were stored/refreshed in localforage */
    refreshedBlobIds: string[];
}

async function loadChatCache(): Promise<ChatMetaCache> {
    const store = getSyncStore();
    return (await store.getItem<ChatMetaCache>(CACHE_KEY)) || {};
}

async function saveChatCache(cache: ChatMetaCache): Promise<void> {
    await getSyncStore().setItem(CACHE_KEY, cache);
}

export async function storeBlob(hash: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return;
    await getSyncStore().setItem(BLOB_PREFIX + hash, Array.from(bytes));
}

export async function loadBlob(hash: string): Promise<Uint8Array | null> {
    const arr = await getSyncStore().getItem<number[]>(BLOB_PREFIX + hash);
    if (!arr) return null;
    return new Uint8Array(arr);
}

export async function saveLocalManifest(manifest: Manifest): Promise<void> {
    await getSyncStore().setItem(LOCAL_MANIFEST_KEY, manifest);
}

export async function loadLocalManifest(): Promise<Manifest | null> {
    return getSyncStore().getItem<Manifest>(LOCAL_MANIFEST_KEY);
}

/**
 * Walk ST via /api/*, hash everything in scope, cache chat hashes by list metadata.
 */
export async function scanLocal(opts: {
    deviceName: string;
    scope: SyncScopeSettings;
    onProgress?: (msg: string) => void;
}): Promise<ScanResult> {
    const { deviceName, scope, onProgress } = opts;
    const items: Record<string, SyncItem> = {};
    const refreshedBlobIds: string[] = [];
    const progress = (m: string) => {
        onProgress?.(m);
        console.log(LOG_PREFIX, 'scan:', m);
    };

    progress('Loading settings bundle…');
    const bundle = await fetchSettingsBundle();

    if (scope.settings) {
        const { item, bytes } = await makeSettingsItem(bundle);
        items[item.id] = item;
        await storeBlob(item.hash, bytes);
        refreshedBlobIds.push(item.id);
    }

    if (scope.lorebooks) {
        progress(`Lorebooks (${bundle.world_names.length})…`);
        for (const { item, bytes } of await listWorldInfo(bundle.world_names)) {
            items[item.id] = item;
            await storeBlob(item.hash, bytes);
            refreshedBlobIds.push(item.id);
        }
    }

    if (scope.presets) {
        progress(`Presets (${bundle.presets.length})…`);
        for (const { item, bytes } of await listPresets(bundle.presets)) {
            items[item.id] = item;
            await storeBlob(item.hash, bytes);
            refreshedBlobIds.push(item.id);
        }
    }

    if (scope.themes) {
        for (const { item, bytes } of await listThemes(bundle.themes)) {
            items[item.id] = item;
            await storeBlob(item.hash, bytes);
            refreshedBlobIds.push(item.id);
        }
    }

    if (scope.quickreplies) {
        for (const { item, bytes } of await listQuickReplies(bundle.quickReplyPresets)) {
            items[item.id] = item;
            await storeBlob(item.hash, bytes);
            refreshedBlobIds.push(item.id);
        }
    }

    if (scope.personas) {
        for (const { item, bytes } of await listPersonas(bundle.settings)) {
            items[item.id] = item;
            await storeBlob(item.hash, bytes);
            refreshedBlobIds.push(item.id);
        }
    }

    let characters: Awaited<ReturnType<typeof listCharacters>> = [];
    if (scope.characters || scope.chats) {
        progress('Characters…');
        characters = await listCharacters();
    }

    if (scope.characters) {
        for (const { item, bytes } of characters) {
            items[item.id] = item;
            await storeBlob(item.hash, bytes);
            refreshedBlobIds.push(item.id);
        }
    }

    if (scope.chats) {
        const cache = await loadChatCache();
        progress(`Chats for ${characters.length} characters…`);
        for (const { avatar } of characters) {
            const chats = await listChatsForCharacter(avatar, cache);
            for (const { item, bytes } of chats) {
                items[item.id] = item;
                if (bytes.byteLength > 0) {
                    await storeBlob(item.hash, bytes);
                    refreshedBlobIds.push(item.id);
                }
            }
        }
        await saveChatCache(cache);
    }

    if (scope.groups) {
        progress('Groups…');
        const { groups, groupChats } = await listGroups();
        for (const { item, bytes } of groups) {
            items[item.id] = item;
            await storeBlob(item.hash, bytes);
            refreshedBlobIds.push(item.id);
        }
        for (const { item, bytes } of groupChats) {
            items[item.id] = item;
            await storeBlob(item.hash, bytes);
            refreshedBlobIds.push(item.id);
        }
    }

    const manifest: Manifest = {
        ...emptyManifest(deviceName),
        items,
    };
    await saveLocalManifest(manifest);
    progress(`Done — ${Object.keys(items).length} items`);
    return { manifest, itemCount: Object.keys(items).length, refreshedBlobIds };
}
