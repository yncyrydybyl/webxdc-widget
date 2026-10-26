/*
 * webxdc realtime channels over Matrix to-device messages. The protocol is
 * described in PLAN.md ("Realtime"); in short:
 *
 * - Data goes unencrypted to every joined member's devices ("*"): clients cannot
 *   encrypt a to-device message for "*" (Element: "unknown device"), and a widget
 *   cannot list devices. In encrypted rooms the widget encrypts the payload itself
 *   (AES-GCM-256, one key per page), and announces the key as an `rt-key` sync event
 *   in the room's encrypted timeline.
 * - Hosts send to-device messages one at a time; what an app sends meanwhile is
 *   batched into the next message (4-byte length framing). A message over 40 kB goes
 *   in parts (webxdc allows 128 kB, a to-device event holds about 64 KiB of JSON).
 * - Per sender page, delivery stays in arrival order; data that comes before its key,
 *   or before the app here joined, waits for it.
 */
import { decodeBase64, encodeBase64, randomId } from "./crypto";
import { LOCAL_PREFIX, REALTIME_TYPE, type RealtimeContent, type SyncKeyContent } from "./events";
import type { RoomApi } from "./room";

/** Realtime data goes to at most this many members; beyond it the channel would flood to-device. */
export const REALTIME_MAX_MEMBERS = 50;
/** Realtime data kept for an app that has not joined yet: how many, how old. */
export const REALTIME_EARLY_MAX = 64;
export const REALTIME_EARLY_MS = 15_000;
/** Realtime data an instance may have waiting; beyond that the oldest is dropped. */
export const REALTIME_MAX_QUEUED = 256;
/** Payload per to-device message, before encryption and base64 (the server takes 64 KiB of JSON). */
export const REALTIME_BATCH_BYTES = 40_000;
/** A key announcement older than this (read back from history) gets no answer. */
const KEY_ANSWER_WINDOW = 120_000;

const utf8 = new TextEncoder();

/** What the channel needs from the room. */
export interface RealtimeHost {
    readonly api: RoomApi | null;
    readonly me: string;
    /** Joined members: the recipients, and the only senders accepted. */
    readonly members: Map<string, string>;
    readonly encrypted: boolean;
    /** Sends a sync event ahead of queued updates (our key). */
    announce(content: SyncKeyContent): void;
}

export interface Channel {
    send(data: Uint8Array): void;
    leave(): void;
}

export class Realtime {
    /** This page's id on realtime channels, so it can ignore its own data coming back. */
    readonly peer = randomId(8);
    private channels = new Map<string, (data: Uint8Array) => void>();
    /** This page's key (encrypted rooms), made on first use. */
    private key: Promise<{ key: CryptoKey; raw: string }> | null = null;
    /** Other pages' keys, by `sender|peer`, and data that came before its key. */
    private peerKeys = new Map<string, CryptoKey>();
    private waiting = new Map<string, RealtimeContent[]>();
    /** Data that came before this page's app joined the channel (it is still starting): handed over on join. */
    private early = new Map<string, { at: number; sender: string; c: RealtimeContent }[]>();
    /** Per sender page: decryption is asynchronous, delivery to the app stays in arrival order (Yjs and the like need it). */
    private delivery = new Map<string, Promise<void>>();
    /** Messages arriving in parts, by `peer|id`. */
    private parts = new Map<string, { at: number; got: (Uint8Array | undefined)[] }>();
    private announced = new Map<string, number>();
    private reannounce = new Map<string, ReturnType<typeof setTimeout>>();
    /** Data waiting for the send in flight to finish, per instance. */
    private outbox = new Map<string, Uint8Array[]>();
    private sending = false;

    constructor(private host: RealtimeHost) {}

    join(instance: string, onData: (data: Uint8Array) => void): Channel {
        this.channels.set(instance, onData);
        void this.announceKey(instance);
        const early = (this.early.get(instance) ?? []).filter((e) => Date.now() - e.at < REALTIME_EARLY_MS);
        this.early.delete(instance);
        for (const e of early) this.receive(e.sender, e.c);
        return {
            // The host sends one to-device message at a time (Element: ~75 ms each); an
            // app may send 30 a second (cursors). Whatever comes meanwhile goes in the next
            // message, so nothing builds up a delay. Ephemeral by spec: past the limit the
            // oldest data is dropped.
            send: (data) => {
                if (!this.host.api || instance.startsWith(LOCAL_PREFIX)) return;
                const box = this.outbox.get(instance) ?? [];
                box.push(data);
                while (box.length > REALTIME_MAX_QUEUED) box.shift();
                this.outbox.set(instance, box);
                void this.flush();
            },
            leave: () => {
                if (this.channels.get(instance) === onData) this.channels.delete(instance);
            },
        };
    }

    // ---- Receiving ----------------------------------------------------------

    onToDevice(ev: { type: string; sender: string; content: unknown }): void {
        if (ev.type !== REALTIME_TYPE) return;
        const c = ev.content as RealtimeContent;
        if (!c || typeof c.instance !== "string" || typeof c.peer !== "string" || c.peer === this.peer) return;
        // Unencrypted to-device messages can come from anyone on any server: only room members count.
        if (!this.host.members.has(ev.sender)) return;
        if (!this.channels.has(c.instance)) {
            // The app here has not joined yet: a newcomer's first messages (its state, its
            // hello) would be lost to it, and some apps (Yjs) never recover from that.
            const early = (this.early.get(c.instance) ?? []).filter((e) => Date.now() - e.at < REALTIME_EARLY_MS);
            early.push({ at: Date.now(), sender: ev.sender, c });
            this.early.set(c.instance, early.slice(-REALTIME_EARLY_MAX));
            return;
        }
        this.receive(ev.sender, c);
    }

    /** A page's key, from an `rt-key` sync event in the timeline. */
    async onKey(sender: string, ts: number, c: SyncKeyContent): Promise<void> {
        if (sender === this.host.me && c.nonce === this.peer) return;
        const id = `${sender}|${c.nonce}`;
        const isNew = !this.peerKeys.has(id);
        try {
            const key = await crypto.subtle.importKey("raw", decodeBase64(c.key), "AES-GCM", false, ["decrypt"]);
            this.peerKeys.set(id, key);
            const waiting = this.waiting.get(id) ?? [];
            this.waiting.delete(id);
            for (const w of waiting) this.inOrder(id, () => this.decrypt(key, w));
        } catch {
            return;
        }
        // A page we did not know: it may have missed our announcement (it was not
        // running yet, and a widget reads back only part of the timeline), so ours again.
        if (isNew && this.channels.has(c.instance) && Date.now() - ts < KEY_ANSWER_WINDOW) void this.announceKey(c.instance, true);
    }

    private receive(sender: string, c: RealtimeContent): void {
        if (typeof c.ct === "string" && typeof c.iv === "string") {
            const id = `${sender}|${c.peer}`;
            const key = this.peerKeys.get(id);
            if (key) this.inOrder(id, () => this.decrypt(key, c));
            else {
                // Its key is on the way through the timeline.
                const waiting = this.waiting.get(id) ?? [];
                if (waiting.length < 64) waiting.push(c);
                this.waiting.set(id, waiting);
            }
        } else if (typeof c.data === "string" && !this.host.encrypted) {
            try {
                this.deliver(c, decodeBase64(c.data));
            } catch {
                /* malformed */
            }
        }
    }

    private inOrder(id: string, step: () => Promise<void>): void {
        this.delivery.set(id, (this.delivery.get(id) ?? Promise.resolve()).then(step, step));
    }

    private async decrypt(key: CryptoKey, c: RealtimeContent): Promise<void> {
        try {
            const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(c.iv!), additionalData: utf8.encode(c.instance) }, key, decodeBase64(c.ct!));
            this.deliver(c, new Uint8Array(plain));
        } catch {
            /* not for this key, or tampered with */
        }
    }

    /** One message, each of a batch, or (when the last part is in) a message sent in parts. */
    private deliver(c: RealtimeContent, payload: Uint8Array): void {
        const handler = this.channels.get(c.instance);
        if (!handler) return;
        if (c.part) {
            const { id, i, n } = c.part;
            if (!(n > 1 && n <= 8 && i >= 0 && i < n)) return; // 8 × 40 kB covers the 128 kB webxdc allows
            const key = `${c.peer}|${id}`;
            // Array.from, not new Array(n): some() skips the holes of a sparse array.
            const parts = this.parts.get(key) ?? { at: Date.now(), got: Array.from<Uint8Array | undefined>({ length: n }) };
            parts.got[i] = payload;
            this.parts.set(key, parts);
            for (const [k, p] of this.parts) if (Date.now() - p.at > 60_000) this.parts.delete(k);
            if (parts.got.some((x) => !x)) return;
            this.parts.delete(key);
            const whole = new Uint8Array(parts.got.reduce((t, x) => t + x!.length, 0));
            let at = 0;
            for (const x of parts.got) {
                whole.set(x!, at);
                at += x!.length;
            }
            handler(whole);
            return;
        }
        for (const m of c.batch === 1 ? unframe(payload) : [payload]) handler(m);
    }

    // ---- Sending ------------------------------------------------------------

    private ownKey(): Promise<{ key: CryptoKey; raw: string }> {
        return (this.key ??= (async () => {
            const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
            return { key, raw: encodeBase64(new Uint8Array(await crypto.subtle.exportKey("raw", key))) };
        })());
    }

    /** Our key into the room's encrypted timeline; again when a new page appears (`again`), at most every 2 s. */
    private async announceKey(instance: string, again = false): Promise<void> {
        if (!this.host.api || !this.host.encrypted || instance.startsWith(LOCAL_PREFIX)) return;
        const last = this.announced.get(instance);
        if (last !== undefined && !again) return;
        if (last !== undefined && Date.now() - last < 2_000) {
            // Several newcomers at once share one announcement, a little later.
            if (!this.reannounce.has(instance))
                this.reannounce.set(
                    instance,
                    setTimeout(() => {
                        this.reannounce.delete(instance);
                        void this.announceKey(instance, true);
                    }, last + 2_000 - Date.now()),
                );
            return;
        }
        this.announced.set(instance, Date.now());
        const { raw } = await this.ownKey();
        this.host.announce({ v: 1, instance, kind: "rt-key", nonce: this.peer, key: raw });
    }

    private async flush(): Promise<void> {
        if (this.sending || !this.host.api) return;
        this.sending = true;
        try {
            while (this.outbox.size) {
                const [instance, box] = this.outbox.entries().next().value!;
                // Too big for one to-device event: in parts, each its own message.
                if (box[0].length > REALTIME_BATCH_BYTES) {
                    const big = box.shift()!;
                    if (!box.length) this.outbox.delete(instance);
                    const id = randomId(6);
                    const n = Math.ceil(big.length / REALTIME_BATCH_BYTES);
                    for (let i = 0; i < n; i++) {
                        const content = await this.seal(instance, big.subarray(i * REALTIME_BATCH_BYTES, (i + 1) * REALTIME_BATCH_BYTES));
                        delete content.batch;
                        content.part = { id, i, n };
                        await this.sendToDevice(content).catch(() => undefined);
                    }
                    continue;
                }
                // What fits in one to-device message.
                const take: Uint8Array[] = [];
                let size = 0;
                while (box.length && (take.length === 0 || size + box[0].length + 4 <= REALTIME_BATCH_BYTES)) {
                    const next = box.shift()!;
                    take.push(next);
                    size += next.length + 4;
                }
                if (!box.length) this.outbox.delete(instance);
                await this.sendToDevice(await this.seal(instance, frame(take))).catch(() => undefined);
            }
        } finally {
            this.sending = false;
        }
    }

    private async seal(instance: string, payload: Uint8Array): Promise<RealtimeContent> {
        if (!this.host.encrypted) return { instance, peer: this.peer, batch: 1, data: encodeBase64(payload) };
        const { key } = await this.ownKey();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(instance) }, key, payload as Uint8Array<ArrayBuffer>);
        return { instance, peer: this.peer, batch: 1, iv: encodeBase64(iv), ct: encodeBase64(new Uint8Array(ct)) };
    }

    private async sendToDevice(content: RealtimeContent): Promise<void> {
        const api = this.host.api;
        if (!api) return;
        // Every joined member, including my other devices.
        const members = this.host.members;
        const targets = [...(members.size ? members.keys() : [this.host.me])].slice(0, REALTIME_MAX_MEMBERS);
        await api.sendToDevice(REALTIME_TYPE, false, Object.fromEntries(targets.map((u) => [u, { "*": content }])));
    }
}

/** Messages as one payload: each a 4-byte big-endian length, then its bytes. */
export function frame(messages: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(messages.reduce((n, m) => n + 4 + m.length, 0));
    const view = new DataView(out.buffer);
    let at = 0;
    for (const m of messages) {
        view.setUint32(at, m.length);
        out.set(m, at + 4);
        at += 4 + m.length;
    }
    return out;
}

export function unframe(payload: Uint8Array): Uint8Array[] {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const out: Uint8Array[] = [];
    for (let at = 0; at + 4 <= payload.length; ) {
        const len = view.getUint32(at);
        if (at + 4 + len > payload.length) break;
        out.push(payload.slice(at + 4, at + 4 + len));
        at += 4 + len;
    }
    return out;
}
