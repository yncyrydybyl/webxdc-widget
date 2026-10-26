/*
 * Matrix attachment encryption (AES-CTR-256, SHA-256 over the ciphertext), the
 * same scheme clients use for files in E2EE rooms. Used for sendToChat() files in
 * encrypted rooms, and always for update and history blobs the widget spills to
 * the media repo: the key travels in the (encrypted) timeline event.
 *
 * Decryption follows pdf-viewer-widget's decrypt.ts.
 */
import type { EncryptedFile } from "./events";

export function decodeBase64(input: string): Uint8Array<ArrayBuffer> {
    const normalised = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalised.padEnd(normalised.length + ((4 - (normalised.length % 4)) % 4), "=");
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

/** Unpadded standard base64: the alphabet Matrix uses for keys, IVs and hashes. */
export function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary).replace(/=+$/, "");
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId(bytes = 12): string {
    return encodeBase64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_");
}

export function randomHex(bytes = 8): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function encryptAttachment(plaintext: Uint8Array<ArrayBuffer>): Promise<{ data: Uint8Array<ArrayBuffer>; info: Omit<EncryptedFile, "url"> }> {
    const key = await crypto.subtle.generateKey({ name: "AES-CTR", length: 256 }, true, ["encrypt", "decrypt"]);
    const iv = new Uint8Array(16);
    // The spec fixes the lower 64 bits of the counter block at zero; the upper half is random.
    crypto.getRandomValues(iv.subarray(0, 8));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, plaintext));
    const jwk = await crypto.subtle.exportKey("jwk", key);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    return {
        data,
        info: {
            key: { kty: "oct", key_ops: ["encrypt", "decrypt"], alg: "A256CTR", k: jwk.k!, ext: true },
            iv: encodeBase64(iv),
            hashes: { sha256: encodeBase64(hash) },
            v: "v2",
        },
    };
}

/** Verifies the ciphertext against the advertised SHA-256 before decrypting, as the spec requires. */
export async function decryptAttachment(ciphertext: Uint8Array<ArrayBuffer>, info: EncryptedFile): Promise<Uint8Array<ArrayBuffer>> {
    if (info?.key?.alg !== "A256CTR" || !info.iv || !info.hashes?.sha256) throw new Error("Unsupported encrypted file");
    const actual = encodeBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", ciphertext)));
    if (actual !== info.hashes.sha256.replace(/=+$/, "")) throw new Error("The file does not match the hash in its event");
    const keyBytes = decodeBase64(info.key.k);
    if (keyBytes.length !== 32) throw new Error("Expected a 256-bit key");
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, false, ["decrypt"]);
    const counter = decodeBase64(info.iv);
    if (counter.length !== 16) throw new Error("Expected a 128-bit IV");
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter, length: 64 }, key, ciphertext));
}
