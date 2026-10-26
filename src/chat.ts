/*
 * webxdc.sendToChat(): what an app hands to the chat, as room messages. The
 * widget asks the user first (App.svelte); this is the sending.
 */
import { encryptAttachment } from "./crypto";
import type { RoomApi } from "./room";
import { parseXdc, type Xdc } from "./xdc";

export interface ChatMessage {
    text?: string;
    file?: { name: string; blob: Blob; type?: string };
}

/** What sending needs from the room. */
export interface ChatHost {
    api: RoomApi | null;
    encrypted: boolean;
    /** Lists an .xdc as an app in the room; rejects when the file is no app or the user may not add apps. */
    addInstance(xdc: Xdc, bytes: Uint8Array<ArrayBuffer>): Promise<string>;
    /** A room event through the room's rate limiting; false when it could not be sent. */
    sendEvent(type: string, content: unknown): Promise<boolean>;
}

/** After the user confirmed it: the file (encrypted in an E2EE room) and the text as messages. */
export async function sendToChat(host: ChatHost, message: ChatMessage): Promise<void> {
    const { api } = host;
    if (!api) throw new Error("not connected to a room");
    // An app that makes apps (Delta Chat posts those playable): list it in the room.
    if (message.file && isXdcName(message.file.name)) {
        const bytes = new Uint8Array(await message.file.blob.arrayBuffer());
        const added = await parseXdc(bytes, message.file.name.replace(/\.xdc$/i, ""))
            .then((xdc) => host.addInstance(xdc, bytes))
            .catch(() => null); // not a valid app, or no right to add apps: send it as a file
        if (added) message = { text: message.text };
    }
    if (message.file) {
        const plain = new Uint8Array(await message.file.blob.arrayBuffer());
        const mimetype = mimeFor(message.file.name, message.file.type || message.file.blob.type);
        const msgtype = /^image\/(png|jpeg|gif|webp)$/.test(mimetype) ? "m.image" : "m.file";
        const content: Record<string, unknown> = { msgtype, body: message.file.name, filename: message.file.name, info: { size: plain.length, mimetype } };
        if (host.encrypted) {
            const { data, info } = await encryptAttachment(plain);
            const { content_uri } = await api.uploadFile(new Blob([data]));
            content.file = { url: content_uri, ...info };
        } else {
            content.url = (await api.uploadFile(new Blob([plain], { type: mimetype }))).content_uri;
        }
        if (!(await host.sendEvent("m.room.message", content))) throw new Error("could not send the file");
    }
    if (message.text) {
        if (!(await host.sendEvent("m.room.message", { msgtype: "m.text", body: message.text }))) throw new Error("could not send the text");
    }
}

export function isXdcName(name: string): boolean {
    return /\.xdc$/i.test(name);
}

const MIME_BY_EXT: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", ics: "text/calendar", vcf: "text/vcard",
    html: "text/html", pdf: "application/pdf", zip: "application/zip", xdc: "application/x-webxdc",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm",
};

/** Apps pass "image" or nothing as often as a MIME type: trust only a type/subtype, else go by the file name. */
export function mimeFor(name: string, given?: string): string {
    if (given && /^[\w.+-]+\/[\w.+-]+$/.test(given) && given !== "application/octet-stream") return given;
    return MIME_BY_EXT[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
