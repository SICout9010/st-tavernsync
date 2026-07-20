/** Extension settings schema + defaults + migrate. */

export const LOG_PREFIX = '[TavernSync]';
export const MODULE_NAME = 'tavernsync';

/** Folder name under scripts/extensions/ when installed (third-party or system). */
export const EXTENSION_FOLDER = 'third-party/st-tavernsync';

export type BackendMode = 'managed' | 'custom';

export interface SyncScopeSettings {
    settings: boolean;
    characters: boolean;
    chats: boolean;
    lorebooks: boolean;
    presets: boolean;
    personas: boolean;
    groups: boolean;
    quickreplies: boolean;
    themes: boolean;
}

export interface TavernSyncSettings {
    backendMode: BackendMode;
    endpoint: string;
    deviceName: string;
    deviceToken: string;
    scope: SyncScopeSettings;
    autoSyncOnStartup: boolean;
    autoSyncOnChatClose: boolean;
    propagateDeletes: boolean;
    e2eeEnabled: boolean;
    /** Base64 PBKDF2 salt — never store the passphrase itself */
    e2eeSalt: string;
    lastStatusMessage: string;
    lastItemCount: number;
}

export const defaultSettings: Readonly<TavernSyncSettings> = Object.freeze({
    backendMode: 'custom',
    endpoint: '',
    deviceName: '',
    deviceToken: '',
    scope: Object.freeze({
        settings: true,
        characters: true,
        chats: true,
        lorebooks: true,
        presets: true,
        personas: true,
        groups: true,
        quickreplies: true,
        themes: true,
    }),
    autoSyncOnStartup: false,
    autoSyncOnChatClose: false,
    propagateDeletes: false,
    e2eeEnabled: true,
    e2eeSalt: '',
    lastStatusMessage: 'Never synced',
    lastItemCount: 0,
});

function getCtx() {
    return SillyTavern.getContext();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function backfillScope(target: SyncScopeSettings, defaults: SyncScopeSettings): void {
    for (const key of Object.keys(defaults) as (keyof SyncScopeSettings)[]) {
        if (typeof target[key] !== 'boolean') {
            target[key] = defaults[key];
        }
    }
}

/**
 * Ensure extensionSettings.tavernsync exists and is migrated to current defaults.
 * Never store bulk data or secrets beyond the small device token here.
 */
export function getSettings(): TavernSyncSettings {
    const ctx = getCtx();
    const all = ctx.extensionSettings;

    if (!isPlainObject(all[MODULE_NAME])) {
        all[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = all[MODULE_NAME] as TavernSyncSettings;

    for (const key of Object.keys(defaultSettings) as (keyof TavernSyncSettings)[]) {
        if (!Object.hasOwn(settings as object, key)) {
            (settings as unknown as Record<string, unknown>)[key] = structuredClone(defaultSettings[key]);
        }
    }

    if (!isPlainObject(settings.scope)) {
        settings.scope = structuredClone(defaultSettings.scope);
    } else {
        backfillScope(settings.scope, defaultSettings.scope);
    }

    if (typeof settings.backendMode !== 'string' || (settings.backendMode !== 'managed' && settings.backendMode !== 'custom')) {
        settings.backendMode = defaultSettings.backendMode;
    }

    if (typeof settings.endpoint !== 'string') settings.endpoint = '';
    if (typeof settings.deviceName !== 'string') settings.deviceName = '';
    if (typeof settings.deviceToken !== 'string') settings.deviceToken = '';
    if (typeof settings.lastStatusMessage !== 'string') {
        settings.lastStatusMessage = defaultSettings.lastStatusMessage;
    }
    if (typeof settings.e2eeSalt !== 'string') settings.e2eeSalt = '';
    if (typeof settings.lastItemCount !== 'number') settings.lastItemCount = 0;

    settings.autoSyncOnStartup = !!settings.autoSyncOnStartup;
    settings.autoSyncOnChatClose = !!settings.autoSyncOnChatClose;
    settings.propagateDeletes = !!settings.propagateDeletes;
    settings.e2eeEnabled = settings.e2eeEnabled !== false;

    return settings;
}

export function saveSettings(): void {
    getCtx().saveSettingsDebounced();
}

/** Default device label if the user has not set one. */
export function ensureDeviceName(): string {
    const settings = getSettings();
    if (settings.deviceName.trim()) {
        return settings.deviceName.trim();
    }
    const fallback = typeof navigator !== 'undefined' && navigator.platform
        ? `device-${navigator.platform}`.replace(/\s+/g, '-').toLowerCase()
        : 'device-unknown';
    settings.deviceName = fallback;
    saveSettings();
    return fallback;
}
