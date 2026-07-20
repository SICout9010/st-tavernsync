/**
 * localforage instance for base manifest + scan cache.
 * Do NOT put bulk data in extensionSettings.
 * Unused until M2.
 */

import { MODULE_NAME } from '../settings';

let store: LocalForageInstance | null = null;

export function getSyncStore(): LocalForageInstance {
    if (store) {
        return store;
    }
    store = SillyTavern.libs.localforage.createInstance({
        name: MODULE_NAME,
        storeName: 'sync_state',
    });
    return store;
}

export const BASE_KEY = 'tavernsync_base';
