import type { ItemType, SyncItem } from '../sync-core/types';
import { stFetchBytes, stFetchJson } from './http';
import {
    canonicalizeJsonl,
    canonicalJson,
    jsonlFromMessages,
    sha256Hex,
    stripSettingsForSync,
} from './normalize';

export interface BlobPayload {
    id: string;
    type: ItemType;
    bytes: Uint8Array;
    mtime: number;
}

export interface SettingsBundle {
    settings: Record<string, unknown>;
    world_names: string[];
    /** Preset name lists + contents from /api/settings/get */
    presets: PresetEntry[];
    themes: unknown[];
    quickReplyPresets: unknown[];
}

export interface PresetEntry {
    apiId: string;
    name: string;
    preset: unknown;
}

const PRESET_SOURCES: { apiId: string; namesKey: string; dataKey: string }[] = [
    { apiId: 'kobold', namesKey: 'koboldai_setting_names', dataKey: 'koboldai_settings' },
    { apiId: 'novel', namesKey: 'novelai_setting_names', dataKey: 'novelai_settings' },
    { apiId: 'openai', namesKey: 'openai_setting_names', dataKey: 'openai_settings' },
    { apiId: 'textgenerationwebui', namesKey: 'textgenerationwebui_preset_names', dataKey: 'textgenerationwebui_presets' },
];

const OBJECT_PRESET_SOURCES: { apiId: string; key: string }[] = [
    { apiId: 'instruct', key: 'instruct' },
    { apiId: 'context', key: 'context' },
    { apiId: 'sysprompt', key: 'sysprompt' },
    { apiId: 'reasoning', key: 'reasoning' },
];

export async function fetchSettingsBundle(): Promise<SettingsBundle> {
    const raw = await stFetchJson<Record<string, unknown>>('/api/settings/get', {});
    const settingsStr = typeof raw.settings === 'string' ? raw.settings : '{}';
    let settings: Record<string, unknown>;
    try {
        settings = JSON.parse(settingsStr) as Record<string, unknown>;
    } catch {
        settings = {};
    }

    const presets: PresetEntry[] = [];
    for (const src of PRESET_SOURCES) {
        const names = (raw[src.namesKey] as string[]) || [];
        const data = (raw[src.dataKey] as string[]) || [];
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            let preset: unknown = data[i];
            if (typeof preset === 'string') {
                try {
                    preset = JSON.parse(preset);
                } catch {
                    /* keep string */
                }
            }
            presets.push({ apiId: src.apiId, name, preset });
        }
    }
    for (const src of OBJECT_PRESET_SOURCES) {
        const arr = (raw[src.key] as unknown[]) || [];
        for (const item of arr) {
            if (item && typeof item === 'object' && 'name' in (item as object)) {
                const name = String((item as { name: string }).name);
                presets.push({ apiId: src.apiId, name, preset: item });
            }
        }
    }

    return {
        settings,
        world_names: (raw.world_names as string[]) || [],
        presets,
        themes: (raw.themes as unknown[]) || [],
        quickReplyPresets: (raw.quickReplyPresets as unknown[]) || [],
    };
}

export async function makeSettingsItem(bundle: SettingsBundle): Promise<{ item: SyncItem; bytes: Uint8Array }> {
    const stripped = stripSettingsForSync(bundle.settings);
    const json = canonicalJson(stripped);
    const bytes = new TextEncoder().encode(json);
    const hash = await sha256Hex(bytes);
    return {
        item: {
            id: 'settings/root',
            type: 'settings',
            hash,
            size: bytes.byteLength,
            mtime: Date.now(),
        },
        bytes,
    };
}

export async function listWorldInfo(names: string[]): Promise<{ item: SyncItem; bytes: Uint8Array }[]> {
    const out: { item: SyncItem; bytes: Uint8Array }[] = [];
    for (const name of names) {
        const data = await stFetchJson<Record<string, unknown>>('/api/worldinfo/get', { name });
        const json = canonicalJson(data);
        const bytes = new TextEncoder().encode(json);
        const hash = await sha256Hex(bytes);
        out.push({
            item: {
                id: `worldinfo/${name}`,
                type: 'worldinfo',
                hash,
                size: bytes.byteLength,
                mtime: Date.now(),
            },
            bytes,
        });
    }
    return out;
}

export async function listPresets(presets: PresetEntry[]): Promise<{ item: SyncItem; bytes: Uint8Array }[]> {
    const out: { item: SyncItem; bytes: Uint8Array }[] = [];
    for (const p of presets) {
        const json = canonicalJson(p.preset);
        const bytes = new TextEncoder().encode(json);
        const hash = await sha256Hex(bytes);
        out.push({
            item: {
                id: `preset/${p.apiId}/${p.name}`,
                type: 'preset',
                hash,
                size: bytes.byteLength,
                mtime: Date.now(),
            },
            bytes,
        });
    }
    return out;
}

export async function listThemes(themes: unknown[]): Promise<{ item: SyncItem; bytes: Uint8Array }[]> {
    const out: { item: SyncItem; bytes: Uint8Array }[] = [];
    for (const theme of themes) {
        const name = theme && typeof theme === 'object' && 'name' in theme
            ? String((theme as { name: string }).name)
            : null;
        if (!name) continue;
        const json = canonicalJson(theme);
        const bytes = new TextEncoder().encode(json);
        const hash = await sha256Hex(bytes);
        out.push({
            item: {
                id: `theme/${name}`,
                type: 'theme',
                hash,
                size: bytes.byteLength,
                mtime: Date.now(),
            },
            bytes,
        });
    }
    return out;
}

export async function listQuickReplies(sets: unknown[]): Promise<{ item: SyncItem; bytes: Uint8Array }[]> {
    const out: { item: SyncItem; bytes: Uint8Array }[] = [];
    for (const set of sets) {
        const name = set && typeof set === 'object' && 'name' in set
            ? String((set as { name: string }).name)
            : null;
        if (!name) continue;
        const json = canonicalJson(set);
        const bytes = new TextEncoder().encode(json);
        const hash = await sha256Hex(bytes);
        out.push({
            item: {
                id: `quickreply/${name}`,
                type: 'quickreply',
                hash,
                size: bytes.byteLength,
                mtime: Date.now(),
            },
            bytes,
        });
    }
    return out;
}

interface CharListEntry {
    avatar: string;
    name?: string;
    date_last_chat?: number;
    chat_size?: number;
    json_data?: string;
}

export async function listCharacters(): Promise<{ item: SyncItem; bytes: Uint8Array; avatar: string }[]> {
    const chars = await stFetchJson<CharListEntry[]>('/api/characters/all', {});
    if (!Array.isArray(chars)) return [];
    const out: { item: SyncItem; bytes: Uint8Array; avatar: string }[] = [];
    for (const ch of chars) {
        if (!ch?.avatar) continue;
        // Prefer PNG bytes for hash (CONTEXT). Fallback to json_data if fetch fails.
        let bytes: Uint8Array;
        try {
            bytes = await stFetchBytes(`/characters/${encodeURIComponent(ch.avatar)}`);
        } catch {
            const json = ch.json_data || canonicalJson(ch);
            bytes = new TextEncoder().encode(json);
        }
        const hash = await sha256Hex(bytes);
        out.push({
            avatar: ch.avatar,
            bytes,
            item: {
                id: `character/${ch.avatar}`,
                type: 'character',
                hash,
                size: bytes.byteLength,
                mtime: ch.date_last_chat || Date.now(),
            },
        });
    }
    return out;
}

interface ChatListEntry {
    file_id: string;
    file_name: string;
    file_size?: string;
    chat_items?: number;
    last_mes?: number | string;
}

export type ChatMetaCache = Record<string, { sig: string; hash: string; size: number; mtime: number }>;

function chatListSig(entry: ChatListEntry): string {
    return `${entry.file_size || ''}|${entry.chat_items ?? ''}|${entry.last_mes ?? ''}`;
}

export async function listChatsForCharacter(
    avatar: string,
    cache: ChatMetaCache,
): Promise<{ item: SyncItem; bytes: Uint8Array }[]> {
    const list = await stFetchJson<ChatListEntry[] | { error: true }>('/api/characters/chats', {
        avatar_url: avatar,
    });
    if (!Array.isArray(list)) return [];

    const out: { item: SyncItem; bytes: Uint8Array }[] = [];
    for (const entry of list) {
        const fileId = entry.file_id || entry.file_name?.replace(/\.jsonl$/i, '');
        if (!fileId) continue;
        const id = `chat/${avatar}/${fileId}`;
        const sig = chatListSig(entry);
        const cached = cache[id];
        if (cached && cached.sig === sig) {
            out.push({
                item: {
                    id,
                    type: 'chat',
                    hash: cached.hash,
                    size: cached.size,
                    mtime: cached.mtime,
                },
                bytes: new Uint8Array(0), // placeholder — caller must re-fetch for push
            });
            continue;
        }

        const chat = await stFetchJson<unknown[] | Record<string, unknown>>('/api/chats/get', {
            avatar_url: avatar,
            file_name: fileId,
        });
        if (!Array.isArray(chat)) continue;
        const jsonl = jsonlFromMessages(chat);
        const bytes = new TextEncoder().encode(jsonl);
        const hash = await sha256Hex(bytes);
        const mtime = typeof entry.last_mes === 'number' ? entry.last_mes : Date.now();
        cache[id] = { sig, hash, size: bytes.byteLength, mtime };
        out.push({
            item: { id, type: 'chat', hash, size: bytes.byteLength, mtime },
            bytes,
        });
    }
    return out;
}

interface GroupEntry {
    id: string;
    chats?: string[];
    date_last_chat?: number;
    chat_size?: number;
}

export async function listGroups(): Promise<{
    groups: { item: SyncItem; bytes: Uint8Array }[];
    groupChats: { item: SyncItem; bytes: Uint8Array }[];
}> {
    const groups = await stFetchJson<GroupEntry[]>('/api/groups/all', {});
    if (!Array.isArray(groups)) return { groups: [], groupChats: [] };

    const groupItems: { item: SyncItem; bytes: Uint8Array }[] = [];
    const groupChatItems: { item: SyncItem; bytes: Uint8Array }[] = [];
    const seenChats = new Set<string>();

    for (const g of groups) {
        if (!g?.id) continue;
        const json = canonicalJson(g);
        const bytes = new TextEncoder().encode(json);
        const hash = await sha256Hex(bytes);
        groupItems.push({
            item: {
                id: `group/${g.id}`,
                type: 'group',
                hash,
                size: bytes.byteLength,
                mtime: g.date_last_chat || Date.now(),
            },
            bytes,
        });

        for (const chatId of g.chats || []) {
            if (seenChats.has(chatId)) continue;
            seenChats.add(chatId);
            const chat = await stFetchJson<unknown[]>('/api/chats/group/get', { id: chatId });
            const arr = Array.isArray(chat) ? chat : [];
            const jsonl = jsonlFromMessages(arr);
            const cBytes = new TextEncoder().encode(jsonl);
            const cHash = await sha256Hex(cBytes);
            groupChatItems.push({
                item: {
                    id: `groupchat/${chatId}`,
                    type: 'groupchat',
                    hash: cHash,
                    size: cBytes.byteLength,
                    mtime: Date.now(),
                },
                bytes: cBytes,
            });
        }
    }

    return { groups: groupItems, groupChats: groupChatItems };
}

export interface PersonaPayload {
    avatarId: string;
    name: string;
    description: Record<string, unknown> | null;
    /** Raw avatar image as base64 (no data: prefix). May be empty if file missing. */
    imageBase64: string;
}

/** Personas = avatar file under User Avatars/ + power_user.personas / persona_descriptions. */
export async function listPersonas(settings: Record<string, unknown>): Promise<{ item: SyncItem; bytes: Uint8Array }[]> {
    const out: { item: SyncItem; bytes: Uint8Array }[] = [];
    const power = settings.power_user as Record<string, unknown> | undefined;
    const personas = (power?.personas || settings.personas) as Record<string, unknown> | undefined;
    const descriptions = (power?.persona_descriptions || {}) as Record<string, Record<string, unknown>>;

    if (!personas || typeof personas !== 'object' || Array.isArray(personas)) {
        return out;
    }

    for (const [avatarId, nameVal] of Object.entries(personas)) {
        if (!avatarId) continue;
        const name = typeof nameVal === 'string' ? nameVal : String(nameVal ?? avatarId);
        const description = descriptions[avatarId] ? structuredClone(descriptions[avatarId]) : null;

        let imageBase64 = '';
        try {
            const imgBytes = await stFetchBytes(
                `/User%20Avatars/${encodeURIComponent(avatarId)}`,
            );
            imageBase64 = uint8ToBase64(imgBytes);
        } catch {
            // Persona metadata can exist without a file (or default avatar)
        }

        const payload: PersonaPayload = { avatarId, name, description, imageBase64 };
        const json = canonicalJson(payload);
        const bytes = new TextEncoder().encode(json);
        const hash = await sha256Hex(bytes);
        out.push({
            item: {
                id: `persona/${avatarId}`,
                type: 'persona',
                hash,
                size: bytes.byteLength,
                mtime: Date.now(),
            },
            bytes,
        });
    }
    return out;
}

function uint8ToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

export { base64ToUint8 };

// Re-export for apply paths
export { canonicalizeJsonl, canonicalJson, sha256Hex };
