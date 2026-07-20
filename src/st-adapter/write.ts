/** Write / apply paths for pulling remote blobs into ST. */

import { LOG_PREFIX } from '../settings';
import type { ItemType } from '../sync-core/types';
import { stFetchForm, stFetchJson } from './http';
import { base64ToUint8, type PersonaPayload } from './read';

function bytesToBlobPart(bytes: Uint8Array): BlobPart {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function writeWorldInfo(name: string, data: unknown): Promise<void> {
    await stFetchJson('/api/worldinfo/edit', { name, data });
}

export async function writePreset(apiId: string, name: string, preset: unknown): Promise<void> {
    await stFetchJson('/api/presets/save', { apiId, name, preset });
}

export async function writeChat(
    avatarUrl: string,
    fileName: string,
    chat: unknown[],
    force = true,
): Promise<void> {
    await stFetchJson('/api/chats/save', {
        avatar_url: avatarUrl,
        file_name: fileName,
        chat,
        force,
    });
}

export async function writeGroupChat(id: string, chat: unknown[], force = true): Promise<void> {
    await stFetchJson('/api/chats/group/save', { id, chat, force });
}

export async function writeGroup(group: unknown): Promise<void> {
    await stFetchJson('/api/groups/edit', group);
}

export async function writeSettings(settings: Record<string, unknown>): Promise<void> {
    await stFetchJson('/api/settings/save', settings);
}

export async function importCharacterPng(pngBytes: Uint8Array, preservedName?: string): Promise<string> {
    const form = new FormData();
    const blob = new Blob([bytesToBlobPart(pngBytes)], { type: 'image/png' });
    form.append('avatar', blob, preservedName ? `${preservedName}.png` : 'character.png');
    form.append('file_type', 'png');
    if (preservedName) {
        form.append('preserved_name', preservedName.replace(/\.png$/i, ''));
    }
    const res = await stFetchForm<{ file_name: string }>('/api/characters/import', form);
    return `${res.file_name}.png`;
}

export async function uploadPersonaAvatar(imageBytes: Uint8Array, avatarId: string): Promise<string> {
    const form = new FormData();
    const filename = avatarId.endsWith('.png') ? avatarId : `${avatarId}.png`;
    const blob = new Blob([bytesToBlobPart(imageBytes)], { type: 'image/png' });
    form.append('avatar', blob, filename);
    form.append('overwrite_name', filename);
    const res = await stFetchForm<{ path: string }>('/api/avatars/upload', form);
    return res.path || filename;
}

/** Merge persona name + description into settings.json and optionally upload avatar image. */
export async function writePersona(payload: PersonaPayload): Promise<void> {
    const avatarId = payload.avatarId;
    if (!avatarId) throw new Error('Persona payload missing avatarId');

    if (payload.imageBase64) {
        await uploadPersonaAvatar(base64ToUint8(payload.imageBase64), avatarId);
    }

    const raw = await stFetchJson<{ settings: string }>('/api/settings/get', {});
    const full = JSON.parse(raw.settings || '{}') as Record<string, unknown>;
    if (!full.power_user || typeof full.power_user !== 'object') {
        full.power_user = {};
    }
    const power = full.power_user as Record<string, unknown>;
    const personas = (power.personas && typeof power.personas === 'object'
        ? power.personas
        : {}) as Record<string, string>;
    const descriptions = (power.persona_descriptions && typeof power.persona_descriptions === 'object'
        ? power.persona_descriptions
        : {}) as Record<string, Record<string, unknown>>;

    personas[avatarId] = payload.name || avatarId;
    if (payload.description) {
        descriptions[avatarId] = payload.description;
    } else if (!descriptions[avatarId]) {
        descriptions[avatarId] = {
            description: '',
            position: 0,
            depth: 2,
            role: 0,
            lorebook: '',
            title: '',
        };
    }

    power.personas = personas;
    power.persona_descriptions = descriptions;
    await writeSettings(full);
}

export function parseItemId(id: string): { type: ItemType; parts: string[] } {
    const [type, ...rest] = id.split('/');
    return { type: type as ItemType, parts: rest };
}

export function decodeUtf8Json(bytes: Uint8Array): unknown {
    return JSON.parse(new TextDecoder().decode(bytes));
}

export function decodeUtf8Jsonl(bytes: Uint8Array): unknown[] {
    const text = new TextDecoder().decode(bytes).replace(/\n+$/, '');
    if (!text) return [];
    return text.split('\n').map((line) => JSON.parse(line));
}

/**
 * Apply a single decrypted blob to local ST. dryRun logs only.
 */
export async function applyLocalItem(
    id: string,
    type: ItemType,
    bytes: Uint8Array,
    dryRun: boolean,
): Promise<void> {
    const { parts } = parseItemId(id);
    console.log(LOG_PREFIX, dryRun ? 'dry-run apply' : 'apply', id, type, bytes.byteLength);

    if (dryRun) return;

    switch (type) {
        case 'worldinfo': {
            const name = parts.join('/');
            const data = decodeUtf8Json(bytes);
            await writeWorldInfo(name, data);
            break;
        }
        case 'preset': {
            const [apiId, ...nameParts] = parts;
            const name = nameParts.join('/');
            const preset = decodeUtf8Json(bytes);
            await writePreset(apiId, name, preset);
            break;
        }
        case 'chat': {
            const avatar = parts[0];
            const fileName = parts.slice(1).join('/');
            const chat = decodeUtf8Jsonl(bytes);
            await writeChat(avatar, fileName, chat, true);
            break;
        }
        case 'groupchat': {
            const chatId = parts.join('/');
            const chat = decodeUtf8Jsonl(bytes);
            await writeGroupChat(chatId, chat, true);
            break;
        }
        case 'group': {
            const group = decodeUtf8Json(bytes);
            await writeGroup(group);
            break;
        }
        case 'character': {
            const avatar = parts.join('/');
            const preserved = avatar.replace(/\.png$/i, '');
            await importCharacterPng(bytes, preserved);
            break;
        }
        case 'settings': {
            const settings = decodeUtf8Json(bytes) as Record<string, unknown>;
            await writeSettings(settings);
            break;
        }
        case 'persona': {
            const raw = decodeUtf8Json(bytes) as PersonaPayload | string;
            // Legacy blobs were just the display-name string
            if (typeof raw === 'string') {
                await writePersona({
                    avatarId: parts.join('/'),
                    name: raw,
                    description: null,
                    imageBase64: '',
                });
                break;
            }
            if (!raw.avatarId) raw.avatarId = parts.join('/');
            await writePersona(raw);
            break;
        }
        case 'theme':
        case 'quickreply': {
            console.warn(LOG_PREFIX, `Apply for ${type} not fully wired; skipping ${id}`);
            break;
        }
        default:
            console.warn(LOG_PREFIX, `Unknown type ${type} for ${id}`);
    }
}
