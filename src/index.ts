import './style.css';
import { HttpStorageAdapter } from './backend/http';
import {
    EXTENSION_FOLDER,
    LOG_PREFIX,
    ensureDeviceName,
    getSettings,
    saveSettings,
    type SyncScopeSettings,
} from './settings';
import { getSyncStore } from './state/store';
import {
    clearBase,
    getStatusDiff,
    hasE2eeKey,
    lockE2ee,
    runScan,
    runSync,
    setGenerationBusy,
    unlockE2ee,
} from './sync/engine';
import { promptConflicts } from './ui/conflict';

function getCtx() {
    return SillyTavern.getContext();
}

function setStatusLine(text: string): void {
    const el = document.getElementById('tavernsync_status_line');
    if (el) {
        el.textContent = text.startsWith('●') ? text : `● ${text}`;
    }
}

async function withLoader<T>(message: string, fn: () => Promise<T>): Promise<T> {
    const ctx = getCtx();
    const handle = ctx.loader?.show({ blocking: false, message, title: 'TavernSync' });
    try {
        return await fn();
    } finally {
        handle?.hide();
    }
}

function hydrateSettingsUI(): void {
    const s = getSettings();
    ensureDeviceName();

    $('#tavernsync_backend_mode').val(s.backendMode);
    $('#tavernsync_endpoint').val(s.endpoint);
    $('#tavernsync_device_name').val(s.deviceName);
    $('#tavernsync_device_token').val(s.deviceToken);

    $('#tavernsync_scope_settings').prop('checked', s.scope.settings);
    $('#tavernsync_scope_characters').prop('checked', s.scope.characters);
    $('#tavernsync_scope_chats').prop('checked', s.scope.chats);
    $('#tavernsync_scope_lorebooks').prop('checked', s.scope.lorebooks);
    $('#tavernsync_scope_presets').prop('checked', s.scope.presets);
    $('#tavernsync_scope_personas').prop('checked', s.scope.personas);
    $('#tavernsync_scope_groups').prop('checked', s.scope.groups);
    $('#tavernsync_scope_quickreplies').prop('checked', s.scope.quickreplies);
    $('#tavernsync_scope_themes').prop('checked', s.scope.themes);

    $('#tavernsync_auto_startup').prop('checked', s.autoSyncOnStartup);
    $('#tavernsync_auto_chat_close').prop('checked', s.autoSyncOnChatClose);
    $('#tavernsync_propagate_deletes').prop('checked', s.propagateDeletes);
    $('#tavernsync_e2ee').prop('checked', s.e2eeEnabled);

    setStatusLine(
        s.lastItemCount
            ? `${s.lastStatusMessage} · ${s.lastItemCount} items`
            : s.lastStatusMessage || 'Never synced',
    );
}

function bindScopeCheckbox(id: string, key: keyof SyncScopeSettings): void {
    $(document).on('change', id, (e: { target: HTMLInputElement }) => {
        getSettings().scope[key] = !!$(e.target).prop('checked');
        saveSettings();
    });
}

function ensureE2eeReady(): boolean {
    const s = getSettings();
    if (!s.e2eeEnabled) return true;
    if (hasE2eeKey()) return true;
    toastr.warning('Unlock E2EE passphrase first.', 'TavernSync');
    return false;
}

async function handleConnect(): Promise<void> {
    const s = getSettings();
    if (!s.endpoint.trim() || !s.deviceToken.trim()) {
        toastr.warning('Set endpoint and device token first.', 'TavernSync');
        return;
    }
    try {
        const adapter = new HttpStorageAdapter({
            endpoint: s.endpoint.trim(),
            deviceToken: s.deviceToken.trim(),
        });
        const { version } = await adapter.getManifest();
        const quota = await adapter.quota();
        $('#tavernsync_quota_line').text(
            `Quota: ${formatBytes(quota.usedBytes)} / ${formatBytes(quota.limitBytes)} · ${quota.itemCount} blobs · manifest v${version}`,
        );
        toastr.success(`Connected (manifest v${version}).`, 'TavernSync');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Connect failed: ${String(e)}`, 'TavernSync');
    }
}

function formatBytes(n: number): string {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function handleScan(): Promise<void> {
    try {
        const result = await withLoader('Scanning local ST data…', async () =>
            runScan((m) => setStatusLine(m)),
        );
        const s = getSettings();
        s.lastItemCount = result.itemCount;
        s.lastStatusMessage = `Indexed ${result.itemCount} items`;
        saveSettings();
        setStatusLine(`${s.lastStatusMessage}`);
        toastr.success(`Indexed ${result.itemCount} items.`, 'TavernSync');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Scan failed: ${String(e)}`, 'TavernSync');
    }
}

async function handleStatus(): Promise<void> {
    try {
        const status = await withLoader('Computing sync status…', () => getStatusDiff());
        const s = getSettings();
        s.lastItemCount = status.itemCount;
        s.lastStatusMessage = `${status.summary.push} to push · ${status.summary.pull} to pull · ${status.summary.conflict} conflict`;
        saveSettings();
        setStatusLine(s.lastStatusMessage);

        const lines = [
            `Items: ${status.itemCount}`,
            s.lastStatusMessage,
            `Device: ${s.deviceName}`,
            `E2EE: ${s.e2eeEnabled ? (hasE2eeKey() ? 'unlocked' : 'locked') : 'off'}`,
            `Remote version: ${status.remoteVersion}`,
        ];
        console.log(LOG_PREFIX, 'Status\n' + lines.join('\n'));
        toastr.info(lines.join(' · '), 'TavernSync status');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Status failed: ${String(e)}`, 'TavernSync');
    }
}

async function handlePush(): Promise<void> {
    if (!ensureE2eeReady()) return;
    try {
        const { message } = await withLoader('Pushing…', () =>
            runSync({
                direction: 'push',
                onProgress: (m) => setStatusLine(m),
                resolveConflict: async (entry) => {
                    const map = await promptConflicts([entry]);
                    return map.get(entry.id) || 'both';
                },
            }),
        );
        setStatusLine(message);
        toastr.success(message, 'TavernSync push');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Push failed: ${String(e)}`, 'TavernSync');
    }
}

async function handlePull(): Promise<void> {
    if (!ensureE2eeReady()) return;
    try {
        const { message } = await withLoader('Pulling…', () =>
            runSync({
                direction: 'pull',
                onProgress: (m) => setStatusLine(m),
                resolveConflict: async (entry) => {
                    const map = await promptConflicts([entry]);
                    return map.get(entry.id) || 'both';
                },
            }),
        );
        setStatusLine(message);
        toastr.success(message, 'TavernSync pull');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Pull failed: ${String(e)}`, 'TavernSync');
    }
}

async function handleUnlockE2ee(): Promise<void> {
    const passphrase = String($('#tavernsync_passphrase').val() || '');
    if (!passphrase) {
        toastr.warning('Enter a passphrase.', 'TavernSync');
        return;
    }
    if (!$('#tavernsync_recovery_ack').prop('checked') && !getSettings().e2eeSalt) {
        toastr.warning('Confirm you have saved your recovery phrase.', 'TavernSync');
        return;
    }
    try {
        await unlockE2ee(passphrase);
        $('#tavernsync_passphrase').val('');
        toastr.success('E2EE unlocked for this session.', 'TavernSync');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error(`Unlock failed: ${String(e)}`, 'TavernSync');
    }
}

function bindSettingsHandlers(): void {
    $(document).on('change', '#tavernsync_backend_mode', (e: { target: HTMLSelectElement }) => {
        const value = String($(e.target).val() || 'custom');
        getSettings().backendMode = value === 'managed' ? 'managed' : 'custom';
        saveSettings();
    });

    $(document).on('input', '#tavernsync_endpoint', (e: { target: HTMLInputElement }) => {
        getSettings().endpoint = String($(e.target).val() || '').trim();
        saveSettings();
    });

    $(document).on('input', '#tavernsync_device_name', (e: { target: HTMLInputElement }) => {
        getSettings().deviceName = String($(e.target).val() || '').trim();
        saveSettings();
    });

    $(document).on('input', '#tavernsync_device_token', (e: { target: HTMLInputElement }) => {
        getSettings().deviceToken = String($(e.target).val() || '').trim();
        saveSettings();
    });

    bindScopeCheckbox('#tavernsync_scope_settings', 'settings');
    bindScopeCheckbox('#tavernsync_scope_characters', 'characters');
    bindScopeCheckbox('#tavernsync_scope_chats', 'chats');
    bindScopeCheckbox('#tavernsync_scope_lorebooks', 'lorebooks');
    bindScopeCheckbox('#tavernsync_scope_presets', 'presets');
    bindScopeCheckbox('#tavernsync_scope_personas', 'personas');
    bindScopeCheckbox('#tavernsync_scope_groups', 'groups');
    bindScopeCheckbox('#tavernsync_scope_quickreplies', 'quickreplies');
    bindScopeCheckbox('#tavernsync_scope_themes', 'themes');

    $(document).on('change', '#tavernsync_auto_startup', (e: { target: HTMLInputElement }) => {
        getSettings().autoSyncOnStartup = !!$(e.target).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#tavernsync_auto_chat_close', (e: { target: HTMLInputElement }) => {
        getSettings().autoSyncOnChatClose = !!$(e.target).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#tavernsync_propagate_deletes', (e: { target: HTMLInputElement }) => {
        getSettings().propagateDeletes = !!$(e.target).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#tavernsync_e2ee', (e: { target: HTMLInputElement }) => {
        getSettings().e2eeEnabled = !!$(e.target).prop('checked');
        saveSettings();
    });

    $(document).on('click', '#tavernsync_connect', () => { void handleConnect(); });
    $(document).on('click', '#tavernsync_push', () => { void handlePush(); });
    $(document).on('click', '#tavernsync_pull', () => { void handlePull(); });
    $(document).on('click', '#tavernsync_status_btn, #tavernsync_status_line', () => { void handleStatus(); });
    $(document).on('click', '#tavernsync_unlock_e2ee', () => { void handleUnlockE2ee(); });
    $(document).on('click', '#tavernsync_change_passphrase', () => {
        lockE2ee();
        toastr.info('Session key cleared.', 'TavernSync');
    });
    $(document).on('click', '#tavernsync_rebuild_index', () => { void handleScan(); });
    $(document).on('click', '#tavernsync_view_log', () => {
        toastr.info('See browser console logs prefixed [TavernSync].', 'TavernSync');
    });
    $(document).on('click', '#tavernsync_reset_state', () => { void handleResetState(); });
}

async function handleResetState(): Promise<void> {
    try {
        await getSyncStore().clear();
        await clearBase();
        const s = getSettings();
        s.lastStatusMessage = 'Never synced';
        s.lastItemCount = 0;
        saveSettings();
        setStatusLine('Never synced');
        toastr.success('Local sync state cleared.', 'TavernSync');
    } catch (e) {
        console.error(LOG_PREFIX, e);
        toastr.error('Failed to reset sync state.', 'TavernSync');
    }
}

async function renderSettingsPanel(): Promise<void> {
    const ctx = getCtx();
    const html = await ctx.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'panel');
    const $target = $('#extensions_settings2');
    if ($target.length) $target.append(html);
    else $('#extensions_settings').append(html);
    bindSettingsHandlers();
    hydrateSettingsUI();
}

function registerSlashCommands(): void {
    const ctx = getCtx();
    const { SlashCommandParser, SlashCommand } = ctx;
    if (!SlashCommandParser || !SlashCommand) {
        console.warn(LOG_PREFIX, 'SlashCommandParser unavailable');
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sync-push',
        aliases: ['tavernsync-push'],
        callback: async () => { await handlePush(); return ''; },
        helpString: 'Push local state to the TavernSync backend.',
        namedArgumentList: [],
        unnamedArgumentList: [],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sync-pull',
        aliases: ['tavernsync-pull'],
        callback: async () => { await handlePull(); return ''; },
        helpString: 'Pull remote TavernSync state into this install.',
        namedArgumentList: [],
        unnamedArgumentList: [],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sync-status',
        aliases: ['tavernsync-status'],
        callback: async () => {
            await handleStatus();
            const s = getSettings();
            return `${s.lastItemCount} items · ${s.lastStatusMessage}`;
        },
        helpString: 'Scan/diff status for TavernSync.',
        namedArgumentList: [],
        unnamedArgumentList: [],
    }));
}

function registerEventListeners(): void {
    const ctx = getCtx();
    const { eventSource, event_types } = ctx;

    const appReady = event_types.APP_READY ?? 'app_ready';
    eventSource.on(appReady, () => {
        console.log(LOG_PREFIX, 'APP_READY');
        // Defer auto-sync — never block hooks (5s timeout)
        if (getSettings().autoSyncOnStartup) {
            setTimeout(() => {
                void (async () => {
                    try {
                        if (!ensureE2eeReady()) return;
                        await runSync({ direction: 'pull', onProgress: (m) => setStatusLine(m) });
                        toastr.info('Auto-pull on startup finished.', 'TavernSync');
                    } catch (e) {
                        console.error(LOG_PREFIX, 'auto-pull failed', e);
                    }
                })();
            }, 2500);
        }
    });

    const genStart = event_types.GENERATION_STARTED ?? 'generation_started';
    const genEnd = event_types.GENERATION_ENDED ?? 'generation_ended';
    eventSource.on(genStart, () => setGenerationBusy(true));
    eventSource.on(genEnd, () => setGenerationBusy(false));

    // Chat close approximation: CHAT_CHANGED after leaving a chat
    const chatChanged = event_types.CHAT_CHANGED ?? 'chat_changed';
    let prevChat = '';
    eventSource.on(chatChanged, () => {
        const s = getSettings();
        if (!s.autoSyncOnChatClose) return;
        const next = String((ctx as { chatId?: string }).chatId ?? '');
        if (prevChat && prevChat !== next) {
            setTimeout(() => {
                void (async () => {
                    try {
                        if (!ensureE2eeReady()) return;
                        await runSync({ direction: 'push', onProgress: (m) => setStatusLine(m) });
                    } catch (e) {
                        console.error(LOG_PREFIX, 'auto-push on chat close failed', e);
                    }
                })();
            }, 1500);
        }
        prevChat = next;
    });
}

export function onInstall(): void {
    console.log(LOG_PREFIX, 'onInstall');
}

export function onActivate(): void {
    console.log(LOG_PREFIX, 'onActivate');
}

export function onClean(): void {
    console.log(LOG_PREFIX, 'onClean');
}

jQuery(async () => {
    try {
        getSettings();
        ensureDeviceName();
        getSyncStore();
        await renderSettingsPanel();
        registerSlashCommands();
        registerEventListeners();
        console.log(LOG_PREFIX, 'loaded');
    } catch (e) {
        console.error(LOG_PREFIX, 'Failed to initialize', e);
        toastr.error('TavernSync failed to load. See console.', 'TavernSync');
    }
});
