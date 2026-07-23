/** PBKDF2 key derivation + AES-GCM box. */

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function b64encode(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

function b64decode(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export async function deriveKey(
    passphrase: string,
    salt?: Uint8Array,
    opts?: { extractable?: boolean },
): Promise<{ key: CryptoKey; salt: Uint8Array }> {
    const usedSalt = salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const extractable = !!opts?.extractable;
    const baseKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: usedSalt as BufferSource,
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256',
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        extractable,
        ['encrypt', 'decrypt'],
    );
    return { key, salt: usedSalt };
}

export async function exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
    // Non-extractable keys can't export — we store derived material via wrap instead.
    // For session storage we re-derive; this helper is for extractable keys only.
    const raw = await crypto.subtle.exportKey('raw', key);
    return new Uint8Array(raw);
}

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
    ]);
}

/** AES-GCM: IV (12) || ciphertext. */
export async function seal(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext as BufferSource);
    const out = new Uint8Array(iv.byteLength + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), iv.byteLength);
    return out;
}

export async function open(key: CryptoKey, boxed: Uint8Array): Promise<Uint8Array> {
    const iv = boxed.slice(0, IV_BYTES);
    const ct = boxed.slice(IV_BYTES);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new Uint8Array(pt);
}

/** HMAC blob key so server can't fingerprint known cards when E2EE is on. */
export async function hmacBlobKey(userSalt: Uint8Array, plaintextHashHex: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', userSalt as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ]);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(plaintextHashHex));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function encodeSalt(salt: Uint8Array): string {
    return b64encode(salt);
}

export function decodeSalt(s: string): Uint8Array {
    return b64decode(s);
}

export { PBKDF2_ITERATIONS };
