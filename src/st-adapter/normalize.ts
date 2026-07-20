/**
 * Canonical JSON, strip lists, hashing.
 * Pure crypto helpers; strip lists are ST-aware but have no I/O.
 */

const TEXT_ENCODER = new TextEncoder();

/** Recursively sort object keys for stable JSON hashing. */
export function sortKeysDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeysDeep);
    }
    if (value !== null && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(obj).sort()) {
            out[key] = sortKeysDeep(obj[key]);
        }
        return out;
    }
    return value;
}

export function canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeysDeep(value));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
    const bytes = typeof data === 'string' ? TEXT_ENCODER.encode(data) : data;
    const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Normalize chat JSONL: LF endings, no trailing newline. */
export function canonicalizeJsonl(text: string): string {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return normalized.replace(/\n+$/, '');
}

export function jsonlFromMessages(messages: unknown[]): string {
    return canonicalizeJsonl(messages.map((m) => JSON.stringify(m)).join('\n'));
}

const KEY_SECRET_PATTERNS = [
    /^api_key/i,
    /_key$/i,
    /proxy_password/i,
    /^token$/i,
    /_token$/i,
    /password/i,
    /secret/i,
];

function isSecretKey(key: string): boolean {
    return KEY_SECRET_PATTERNS.some((re) => re.test(key));
}

/**
 * Strip device-local and secret fields from settings before hash/sync.
 * Always removes extensionSettings.tavernsync to avoid feedback loops.
 */
export function stripSettingsForSync(settings: Record<string, unknown>): Record<string, unknown> {
    const clone = structuredClone(settings) as Record<string, unknown>;

    // Device-local connection / UI truth
    const dropTop = [
        'main_api',
        'api_url_textgenerationwebui',
        'api_server_textgenerationwebui',
        'kai_url',
        'horde_url',
        'novel_api_url',
        'openai_url',
        'claude_url',
        'scale_url',
        'ai21_url',
        'mistralai_url',
        'groq_url',
        'cohere_url',
        'perplexity_url',
        'electronhub_url',
        'nanogpt_url',
        'deepseek_url',
        'xai_url',
        'aimlapi_url',
        'openrouter_url',
        'custom_url',
        'background_fitting',
        'background_url',
        'n_width',
        'n_height',
        'ui_mode',
        'ZAIBATSU',
    ];
    for (const k of dropTop) {
        delete clone[k];
    }

    // Strip secrets recursively
    stripSecretsDeep(clone);

    if (isPlainObject(clone.extensionSettings)) {
        const ext = clone.extensionSettings as Record<string, unknown>;
        delete ext.tavernsync;
        // Strip any nested api keys in other extensions' settings is heavy-handed;
        // still strip secret-looking keys inside extensionSettings.
        stripSecretsDeep(ext);
    }

    // Persona names/descriptions sync as persona/* items (with avatar images)
    if (isPlainObject(clone.power_user)) {
        const pu = clone.power_user as Record<string, unknown>;
        delete pu.personas;
        delete pu.persona_descriptions;
        delete pu.default_persona;
        delete pu.waifuMode;
        stripSecretsDeep(pu);
    }

    return clone;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripSecretsDeep(obj: Record<string, unknown>): void {
    for (const key of Object.keys(obj)) {
        if (isSecretKey(key)) {
            delete obj[key];
            continue;
        }
        const v = obj[key];
        if (isPlainObject(v)) {
            stripSecretsDeep(v);
        } else if (Array.isArray(v)) {
            for (const item of v) {
                if (isPlainObject(item)) stripSecretsDeep(item);
            }
        }
    }
}

/** Field-level 3-way merge for settings objects. Returns merged + conflict keys. */
export function mergeSettingsThreeWay(
    local: Record<string, unknown>,
    base: Record<string, unknown> | null,
    remote: Record<string, unknown>,
): { merged: Record<string, unknown>; conflicts: string[] } {
    const keys = new Set([
        ...Object.keys(local),
        ...Object.keys(remote),
        ...(base ? Object.keys(base) : []),
    ]);
    const merged: Record<string, unknown> = {};
    const conflicts: string[] = [];

    for (const key of keys) {
        const L = local[key];
        const R = remote[key];
        const B = base ? base[key] : undefined;
        const lHash = canonicalJson(L ?? null);
        const rHash = canonicalJson(R ?? null);
        const bHash = canonicalJson(B ?? null);

        if (lHash === rHash) {
            if (L !== undefined) merged[key] = structuredClone(L);
        } else if (base && lHash === bHash && rHash !== bHash) {
            if (R !== undefined) merged[key] = structuredClone(R);
        } else if (base && rHash === bHash && lHash !== bHash) {
            if (L !== undefined) merged[key] = structuredClone(L);
        } else if (!base && L === undefined) {
            merged[key] = structuredClone(R);
        } else if (!base && R === undefined) {
            merged[key] = structuredClone(L);
        } else {
            conflicts.push(key);
            // Prefer local on conflict until user resolves
            if (L !== undefined) merged[key] = structuredClone(L);
            else if (R !== undefined) merged[key] = structuredClone(R);
        }
    }

    return { merged, conflicts };
}
