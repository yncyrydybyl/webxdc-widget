/*
 * The room side of webxdc: which apps the room has, and every app's update log.
 *
 * Independent of the UI and of the app frame, so it can be tested against a fake
 * host. With no host (`api` null) it runs locally: updates loop back to the
 * sender only, which is enough to try an .xdc file without a room.
 */
import type { IRoomEvent } from "matrix-widget-api";
import { decryptAttachment, encryptAttachment, randomHex, randomId, sha256Hex } from "./crypto";
import { sendToChat, type ChatMessage } from "./chat";
import {
    INSTANCE_TYPE,
    LOCAL_PREFIX,
    SYNC_TYPE,
    UPDATE_TYPE,
    WIDGET_KIND,
    WIDGET_TYPE,
    type EncryptedFile,
    type InstanceContent,
    type SyncContent,
    type SyncEntry,
    type UpdateContent,
    type WebxdcUpdate,
    type WireUpdate,
} from "./events";
import { getBlob, InstanceLog, putBlob, type LogEntry } from "./log";
import { Realtime, type Channel } from "./realtime";
import { parseXdc, type Xdc } from "./xdc";

/** The parts of WidgetApi this module uses; a test passes a fake. */
export interface RoomApi {
    sendRoomEvent(type: string, content: unknown): Promise<{ event_id?: string }>;
    sendStateEvent(type: string, stateKey: string, content: unknown): Promise<unknown>;
    readRoomEvents(type: string, limit?: number): Promise<IRoomEvent[]>;
    readStateEvents(type: string, limit?: number, stateKey?: string): Promise<IRoomEvent[]>;
    uploadFile(file: XMLHttpRequestBodyInit): Promise<{ content_uri: string }>;
    downloadFile(uri: string): Promise<{ file: XMLHttpRequestBodyInit }>;
    sendToDevice(type: string, encrypted: boolean, contentMap: Record<string, Record<string, object>>): Promise<unknown>;
}

export interface Instance {
    id: string;
    content: InstanceContent;
    sender: string;
    ts: number;
}

/** What the widget tells apps (webxdc.sendUpdateInterval / sendUpdateMaxSize). */
export const SEND_UPDATE_INTERVAL = 5000;
export const SEND_UPDATE_MAX_SIZE = 128_000;
/**
 * Above this, updates go to the media repo (encrypted) instead of into the event.
 * Events are capped at 64 KiB and encryption grows the payload by a third.
 */
export const INLINE_LIMIT = 36_000;
const NOTICE_INTERVAL = 10_000;
const SYNC_ANSWER_WINDOW = 120_000;

export const PIN_PREFIX = "webxdc_";

/** A token bucket: Synapse allows ~0.2 events/s sustained per user, with bursts of about 10. */
export class Bucket {
    private tokens: number;
    private last: number;

    constructor(
        private size = 6,
        private perSecond = 0.33,
        private now: () => number = Date.now,
    ) {
        this.tokens = size;
        this.last = now();
    }

    private refill(): void {
        const t = this.now();
        this.tokens = Math.min(this.size, this.tokens + ((t - this.last) / 1000) * this.perSecond);
        this.last = t;
    }

    /** Milliseconds until a token is available (0: take it now). */
    wait(): number {
        this.refill();
        return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
    }

    take(): boolean {
        this.refill();
        if (this.tokens < 1) return false;
        this.tokens -= 1;
        return true;
    }

    /** After M_LIMIT_EXCEEDED: the server says we are out, whatever we counted. */
    drain(): void {
        this.tokens = 0;
        this.last = this.now();
    }
}

type Outgoing = { kind: "update"; instance: string; wire: WireUpdate; size: number } | { kind: "event"; type: string; content: unknown };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const utf8 = new TextEncoder();
const byteSize = (v: unknown) => utf8.encode(JSON.stringify(v)).length;

export function localpart(userId: string): string {
    return userId.replace(/^@/, "").split(":")[0] || userId;
}

/** Keeps only the fields webxdc defines, with the types it defines. */
export function sanitizeUpdate(u: Record<string, unknown>): WebxdcUpdate | null {
    if (!u || typeof u !== "object" || u.payload === undefined) return null;
    const out: WebxdcUpdate = { payload: u.payload };
    for (const f of ["info", "href", "document", "summary"] as const) {
        if (typeof u[f] === "string") out[f] = u[f] as string;
    }
    if (u.notify && typeof u.notify === "object" && !Array.isArray(u.notify)) {
        const notify: Record<string, string> = {};
        for (const [k, v] of Object.entries(u.notify as Record<string, unknown>)) if (typeof v === "string") notify[k] = v;
        out.notify = notify;
    }
    return out;
}

/** Retry-after hint of a rate-limited request, or null when the error is something else. */
export function rateLimitDelay(err: unknown): number | null {
    const text = err instanceof Error ? err.message : JSON.stringify(err ?? "");
    const data = (err as { data?: { matrix_api_error?: { response?: { errcode?: string; retry_after_ms?: number }; http_status?: number } } })?.data
        ?.matrix_api_error;
    if (data?.response?.errcode === "M_LIMIT_EXCEEDED" || data?.http_status === 429 || /M_LIMIT_EXCEEDED|429|Too Many Requests/i.test(text)) {
        return Math.max(1000, data?.response?.retry_after_ms ?? 5000);
    }
    return null;
}

export class Room {
    readonly instances = new Map<string, Instance>();
    /** instance id → state key of its own room widget. */
    readonly pinned = new Map<string, string>();
    /** Joined members → display name. */
    readonly members = new Map<string, string>();
    encrypted = false;

    /** Something the UI shows changed. */
    onChange: () => void = () => {};
    /** Something went wrong that the user should know. */
    onError: (message: string) => void = () => {};
    /** How long to wait before answering a history request, so that only one open peer answers. */
    syncDelay = () => 500 + Math.random() * 2500;

    private logs = new Map<string, Promise<InstanceLog>>();
    private subscribers = new Map<string, Set<(e: LogEntry, max: number) => void>>();
    private pushed = new Set<string>();
    private queue: Outgoing[] = [];
    private pumping = false;
    private bucket: Bucket;
    private lastNotice = new Map<string, number>();
    private ownNonces = new Set<string>();
    private answeredNonces = new Set<string>();
    private addrCache = new Map<string, string>();
    private readonly rt: Realtime;

    constructor(
        private api: RoomApi | null,
        readonly me: string,
        /** A pinned tile: only this instance exists for us. */
        readonly only: string | null = null,
        bucket?: Bucket,
    ) {
        this.bucket = bucket ?? new Bucket();
        const room = this;
        this.rt = new Realtime({
            get api() {
                return room.api;
            },
            me,
            members: this.members,
            get encrypted() {
                return room.encrypted;
            },
            announce: (content) => {
                this.queue.unshift({ kind: "event", type: SYNC_TYPE, content });
                void this.pump();
            },
        });
    }

    get live(): boolean {
        return !!this.api;
    }

    /** The host answered: from now on updates go to the room. */
    attach(api: RoomApi): void {
        this.api = api;
    }

    /**
     * An app only on this device (a preview before adding, or standalone use): its
     * updates loop back locally and never reach the room.
     */
    async addLocal(xdc: Xdc, bytes: Uint8Array<ArrayBuffer>): Promise<Instance> {
        await putBlob(xdc.sha256, bytes);
        const inst: Instance = {
            id: `${LOCAL_PREFIX}${randomHex(8)}`,
            content: { v: 1, name: xdc.name, mxc: "", sha256: xdc.sha256, size: xdc.size, source_code_url: xdc.sourceCodeUrl },
            sender: this.me,
            ts: Date.now(),
        };
        this.locals.set(inst.id, inst);
        return inst;
    }

    readonly locals = new Map<string, Instance>();

    // ---- Room state ---------------------------------------------------------

    /**
     * State from the host. A push (update_state, send_event) always wins; an initial
     * read (`fromRead`) fills only keys no push has set, because the Player answers
     * reads from recent timeline events and may return a stale value.
     */
    onState(events: IRoomEvent[], fromRead = false): void {
        let changed = false;
        for (const ev of events) {
            if (ev.state_key === undefined) continue;
            const k = `${ev.type}|${ev.state_key}`;
            if (fromRead && this.pushed.has(k)) continue;
            if (!fromRead) this.pushed.add(k);
            changed = this.applyState(ev) || changed;
        }
        if (changed) this.onChange();
    }

    private applyState(ev: IRoomEvent): boolean {
        const c = ev.content as Record<string, unknown>;
        switch (ev.type) {
            case INSTANCE_TYPE: {
                if (this.only && ev.state_key !== this.only) return false;
                const content = c as unknown as InstanceContent;
                if (content?.v === 1 && typeof content.mxc === "string" && typeof content.sha256 === "string") {
                    this.instances.set(ev.state_key!, { id: ev.state_key!, content, sender: ev.sender, ts: ev.origin_server_ts });
                } else this.instances.delete(ev.state_key!);
                return true;
            }
            case WIDGET_TYPE: {
                if (!ev.state_key!.startsWith(PIN_PREFIX)) return false;
                const instance = ev.state_key!.slice(PIN_PREFIX.length);
                if (typeof c?.url === "string") this.pinned.set(instance, ev.state_key!);
                else this.pinned.delete(instance);
                return true;
            }
            case "m.room.member": {
                if (c?.membership === "join") this.members.set(ev.state_key!, typeof c.displayname === "string" && c.displayname ? c.displayname : localpart(ev.state_key!));
                else this.members.delete(ev.state_key!);
                return true;
            }
            case "m.room.encryption":
                this.encrypted = typeof c?.algorithm === "string";
                return true;
        }
        return false;
    }

    /** Reads what the host did not push (the Player pushes changes only). */
    async readInitialState(): Promise<void> {
        if (!this.api) return;
        const reads: [string, string | undefined][] = this.only
            ? [[INSTANCE_TYPE, this.only], ["m.room.encryption", ""], ["m.room.member", undefined]]
            : [[INSTANCE_TYPE, undefined], [WIDGET_TYPE, undefined], ["m.room.encryption", ""], ["m.room.member", undefined]];
        for (const [type, key] of reads) {
            try {
                this.onState(await this.api.readStateEvents(type, 500, key), true);
            } catch {
                /* not granted, or the host cannot read state: pushes still arrive */
            }
        }
    }

    displayName(userId: string): string {
        return this.members.get(userId) ?? localpart(userId);
    }

    // ---- Timeline -----------------------------------------------------------

    async onEvent(ev: IRoomEvent): Promise<void> {
        if (ev.state_key !== undefined) return this.onState([ev]);
        try {
            if (ev.type === UPDATE_TYPE) await this.onUpdateEvent(ev);
            else if (ev.type === SYNC_TYPE) await this.onSyncEvent(ev);
        } catch (err) {
            console.warn("webxdc: could not read event", ev.event_id, err);
        }
    }

    /** Reads back what the host still has of the timeline (Element: its live timeline; the Player: ~50 events). */
    async backfill(): Promise<void> {
        if (!this.api) return;
        for (const type of [UPDATE_TYPE, SYNC_TYPE]) {
            let events: IRoomEvent[] = [];
            try {
                events = await this.api.readRoomEvents(type, 200);
            } catch {
                continue;
            }
            for (const ev of events.sort((a, b) => a.origin_server_ts - b.origin_server_ts)) await this.onEvent(ev);
        }
    }

    private async onUpdateEvent(ev: IRoomEvent): Promise<void> {
        const c = ev.content as unknown as UpdateContent;
        if (c?.v !== 1 || typeof c.instance !== "string" || !this.wants(c.instance)) return;
        let updates = c.updates;
        if (!Array.isArray(updates) && c.file) updates = JSON.parse(await this.downloadEncrypted(c.file)) as WireUpdate[];
        if (!Array.isArray(updates)) return;
        for (const raw of updates) {
            const update = sanitizeUpdate(raw as unknown as Record<string, unknown>);
            if (!update || typeof raw.id !== "string") continue;
            await this.append(c.instance, { id: raw.id, sender: ev.sender, ts: ev.origin_server_ts, update });
        }
    }

    private wants(instance: string): boolean {
        return !this.only || instance === this.only;
    }

    // ---- Logs ---------------------------------------------------------------

    log(instance: string): Promise<InstanceLog> {
        let p = this.logs.get(instance);
        if (!p) {
            p = InstanceLog.open(instance);
            this.logs.set(instance, p);
        }
        return p;
    }

    private async append(instance: string, entry: Omit<LogEntry, "serial">): Promise<LogEntry | null> {
        const log = await this.log(instance);
        const added = log.add(entry);
        if (!added) return null;
        for (const fn of this.subscribers.get(instance) ?? []) fn(added, log.maxSerial);
        if (added.update.summary || added.update.document) this.onChange();
        return added;
    }

    /** Live entries for an open app; returns the unsubscribe function. */
    subscribe(instance: string, fn: (e: LogEntry, max: number) => void): () => void {
        let set = this.subscribers.get(instance);
        if (!set) this.subscribers.set(instance, (set = new Set()));
        set.add(fn);
        return () => set.delete(fn);
    }

    // ---- Sending ------------------------------------------------------------

    /** webxdc.sendUpdate(): into the local log at once (the sender sees its own update), then to the room. */
    async send(instance: string, update: WebxdcUpdate): Promise<void> {
        const clean = sanitizeUpdate(update as unknown as Record<string, unknown>);
        if (!clean) throw new Error("update.payload must not be undefined");
        const size = byteSize(clean);
        if (size > SEND_UPDATE_MAX_SIZE) throw new Error(`update is ${size} bytes; the limit is ${SEND_UPDATE_MAX_SIZE}`);
        const id = randomId();
        await this.append(instance, { id, sender: this.me, ts: Date.now(), update: clean });
        if (!this.api || instance.startsWith(LOCAL_PREFIX)) return;
        this.queue.push({ kind: "update", instance, wire: { id, ...clean }, size });
        if (clean.info || clean.notify) await this.queueNotice(instance, clean);
        void this.pump();
    }

    /** Sends the queue in order, as fast as the bucket allows; consecutive updates of one app share an event. */
    private async pump(): Promise<void> {
        if (this.pumping || !this.api) return;
        this.pumping = true;
        try {
            while (this.queue.length) {
                const wait = this.bucket.wait();
                if (wait > 0) await sleep(wait);
                if (!this.bucket.take()) continue;
                const head = this.queue[0];
                if (head.kind === "event") {
                    this.queue.shift();
                    await this.sendWithRetry(head.type, head.content);
                    continue;
                }
                const batch: WireUpdate[] = [];
                let size = 0;
                while (this.queue.length) {
                    const q = this.queue[0];
                    if (q.kind !== "update" || q.instance !== head.instance) break;
                    if (batch.length && (size + q.size > INLINE_LIMIT || batch.length >= 100)) break;
                    batch.push(q.wire);
                    size += q.size;
                    this.queue.shift();
                }
                let content: UpdateContent = { v: 1, instance: head.instance, updates: batch };
                if (size > INLINE_LIMIT) {
                    try {
                        content = { v: 1, instance: head.instance, file: await this.uploadEncrypted(JSON.stringify(batch)) };
                    } catch (err) {
                        this.onError(`Could not upload a large update: ${message(err)}`);
                        continue;
                    }
                }
                await this.sendWithRetry(UPDATE_TYPE, content);
            }
        } finally {
            this.pumping = false;
        }
    }

    private async sendWithRetry(type: string, content: unknown): Promise<boolean> {
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                await this.api!.sendRoomEvent(type, content);
                return true;
            } catch (err) {
                const delay = rateLimitDelay(err);
                if (delay === null) {
                    this.onError(`Could not send to the room: ${message(err)}`);
                    return false;
                }
                this.bucket.drain();
                await sleep(delay);
            }
        }
        this.onError("The server keeps rate-limiting this widget; an update was not sent.");
        return false;
    }

    /**
     * update.info becomes a notice in the room ("Chess: Alice moved"), at most one
     * every 10 s per app, as the spec allows dropping older ones. update.notify
     * becomes mentions of the users its addresses belong to.
     */
    private async queueNotice(instance: string, update: WebxdcUpdate): Promise<void> {
        const name = this.instances.get(instance)?.content.name ?? "webxdc";
        const mentions = update.notify ? await this.notifyTargets(instance, update.notify) : new Map<string, string>();
        const now = Date.now();
        if (!mentions.size && now - (this.lastNotice.get(instance) ?? 0) < NOTICE_INTERVAL) return;
        const text = update.info ?? [...new Set(mentions.values())][0];
        if (!text) return;
        this.lastNotice.set(instance, now);
        const body = `${name}: ${oneLine(text, 120)}`;
        const content: Record<string, unknown> = { msgtype: "m.notice", body };
        if (mentions.size) content["m.mentions"] = { user_ids: [...mentions.keys()] };
        this.queue.push({ kind: "event", type: "m.room.message", content });
    }

    /** user id → notification text, for the members `notify` addresses (other than me). */
    private async notifyTargets(instance: string, notify: Record<string, string>): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        const log = await this.log(instance);
        const users = new Set([...this.members.keys(), ...log.entries.map((e) => e.sender)]);
        users.delete(this.me);
        const fallback = notify["*"];
        for (const user of users) {
            const text = notify[await this.addr(user, instance)] ?? fallback;
            if (text) out.set(user, text);
        }
        // "*" in a large room would mention everyone; keep it to small groups.
        if (fallback && out.size > 20) for (const [u, t] of out) if (t === fallback) out.delete(u);
        return out;
    }

    // ---- Identity -----------------------------------------------------------

    /**
     * webxdc.selfAddr: stable for a user within one app, different across apps, so
     * two apps cannot link their users. Anyone who knows the user id and the
     * instance id can compute it; it is a pseudonym, not a secret.
     */
    async addr(userId: string, instance: string): Promise<string> {
        const k = `${instance}|${userId}`;
        let a = this.addrCache.get(k);
        if (!a) {
            a = (await sha256Hex(utf8.encode(`webxdc:${instance}:${userId}`))).slice(0, 32);
            this.addrCache.set(k, a);
        }
        return a;
    }

    // ---- History sync -------------------------------------------------------

    /** Asks open peers for the log; one of them answers with everything it has. */
    async requestSync(instance: string): Promise<void> {
        const log = await this.log(instance);
        log.markSynced();
        if (!this.api || instance.startsWith(LOCAL_PREFIX)) return;
        const nonce = randomId();
        this.ownNonces.add(nonce);
        const content: SyncContent = { v: 1, instance, kind: "request", nonce, have: log.count };
        this.queue.push({ kind: "event", type: SYNC_TYPE, content });
        void this.pump();
    }

    private async onSyncEvent(ev: IRoomEvent): Promise<void> {
        const c = ev.content as unknown as SyncContent;
        if (c?.v !== 1 || typeof c.instance !== "string" || typeof c.nonce !== "string" || !this.wants(c.instance)) return;
        if (c.kind === "rt-key") return this.rt.onKey(ev.sender, ev.origin_server_ts, c);
        if (c.kind === "request") {
            if (this.ownNonces.has(c.nonce) || this.answeredNonces.has(c.nonce)) return;
            // Old requests (read back from history) are not answered again.
            if (Date.now() - ev.origin_server_ts > SYNC_ANSWER_WINDOW) return;
            if (!this.instances.has(c.instance) && !this.logs.has(c.instance)) return;
            const log = await this.log(c.instance);
            if (log.count <= (Number(c.have) || 0)) return;
            // Several peers may be open: the first to answer wins, the others see its offer and stay quiet.
            await sleep(this.syncDelay());
            if (this.answeredNonces.has(c.nonce)) return;
            this.answeredNonces.add(c.nonce);
            await this.sendOffer(c.instance, c.nonce, log);
        } else if (c.kind === "offer") {
            this.answeredNonces.add(c.nonce);
            if (ev.sender === this.me && !this.ownNonces.has(c.nonce)) return; // our own answer coming back
            let entries = c.entries;
            if (!Array.isArray(entries) && c.file) entries = JSON.parse(await this.downloadEncrypted(c.file)) as SyncEntry[];
            if (!Array.isArray(entries)) return;
            for (const e of entries) {
                const update = sanitizeUpdate(e?.update as unknown as Record<string, unknown>);
                if (!update || typeof e.id !== "string" || typeof e.sender !== "string") continue;
                await this.append(c.instance, { id: e.id, sender: e.sender, ts: Number(e.ts) || ev.origin_server_ts, update });
            }
        }
    }

    private async sendOffer(instance: string, nonce: string, log: InstanceLog): Promise<void> {
        const entries: SyncEntry[] = log.entries.map((e) => ({ id: e.id, sender: e.sender, ts: e.ts, update: e.update }));
        const json = JSON.stringify(entries);
        let content: SyncContent = { v: 1, instance, kind: "offer", nonce, count: entries.length, entries };
        if (utf8.encode(json).length > INLINE_LIMIT) {
            try {
                content = { v: 1, instance, kind: "offer", nonce, count: entries.length, file: await this.uploadEncrypted(json) };
            } catch {
                return;
            }
        }
        this.queue.push({ kind: "event", type: SYNC_TYPE, content });
        void this.pump();
    }

    // ---- Media --------------------------------------------------------------

    /** Encrypted upload; the key goes into the (encrypted) event that references it. */
    private async uploadEncrypted(text: string): Promise<EncryptedFile> {
        const { data, info } = await encryptAttachment(utf8.encode(text) as Uint8Array<ArrayBuffer>);
        const { content_uri } = await this.api!.uploadFile(new Blob([data], { type: "application/octet-stream" }));
        return { url: content_uri, ...info };
    }

    private async downloadEncrypted(file: EncryptedFile): Promise<string> {
        const bytes = await this.download(file.url);
        return new TextDecoder().decode(await decryptAttachment(bytes, file));
    }

    private async download(mxc: string): Promise<Uint8Array<ArrayBuffer>> {
        if (!this.api) throw new Error("not connected to a room");
        const { file } = await this.api.downloadFile(mxc);
        return new Uint8Array(await new Response(file).arrayBuffer());
    }

    /** The app's files: from this device's cache, else the media repo, checked against the hash in the state event. */
    async loadXdc(instance: Instance): Promise<{ xdc: Xdc; bytes: Uint8Array<ArrayBuffer> }> {
        let bytes = await getBlob(instance.content.sha256);
        if (!bytes) {
            bytes = await this.download(instance.content.mxc);
            const actual = await sha256Hex(bytes);
            if (actual !== instance.content.sha256) throw new Error("The downloaded app does not match the hash in the room; it was not started.");
            await putBlob(actual, bytes);
        }
        return { xdc: await parseXdc(bytes, instance.content.name), bytes };
    }

    private iconUrls = new Map<string, Promise<string | null>>();

    /** A blob: URL for an app's icon, cached for the page's lifetime. */
    iconUrl(instance: Instance): Promise<string | null> {
        const mxc = instance.content.icon;
        if (!mxc || !this.api) return Promise.resolve(null);
        let p = this.iconUrls.get(mxc);
        if (!p) {
            p = (async () => {
                // An app played on this device has its icon in the cached .xdc already.
                const cached = await getBlob(instance.content.sha256);
                if (cached) {
                    const icon = (await parseXdc(cached).catch(() => null))?.icon;
                    if (icon) return URL.createObjectURL(new Blob([icon.bytes], { type: icon.type }));
                }
                const bytes = await this.download(mxc);
                return bytes.length ? URL.createObjectURL(new Blob([bytes], { type: "image/png" })) : null;
            })().catch(() => null);
            this.iconUrls.set(mxc, p);
        }
        return p;
    }

    // ---- Administration -----------------------------------------------------

    /** Uploads the .xdc (and icon) and writes the instance state event. Needs the room's state power level. */
    async addInstance(
        xdc: Xdc,
        bytes: Uint8Array<ArrayBuffer>,
        extra: { description?: string; origin?: InstanceContent["origin"]; name?: string } = {},
    ): Promise<string> {
        if (!this.api) throw new Error("Open the widget in a room to add apps.");
        const id = randomHex(8);
        const { content_uri: mxc } = await this.api.uploadFile(new Blob([bytes], { type: "application/octet-stream" }));
        let icon: string | undefined;
        if (xdc.icon) {
            try {
                icon = (await this.api.uploadFile(new Blob([xdc.icon.bytes], { type: xdc.icon.type }))).content_uri;
            } catch {
                /* an app without an icon still works */
            }
        }
        const content: InstanceContent = {
            v: 1,
            name: (extra.name ?? xdc.name).slice(0, 100),
            mxc,
            sha256: xdc.sha256,
            size: xdc.size,
            ...(icon ? { icon } : {}),
            ...(extra.description ? { description: extra.description.slice(0, 500) } : {}),
            ...(xdc.sourceCodeUrl ? { source_code_url: xdc.sourceCodeUrl } : {}),
            ...(extra.origin ? { origin: extra.origin } : {}),
        };
        // Plain JSON: callers may hand in reactive proxies, which postMessage cannot clone.
        await this.api.sendStateEvent(INSTANCE_TYPE, id, JSON.parse(JSON.stringify(content)));
        await putBlob(xdc.sha256, bytes);
        this.onState([localState(INSTANCE_TYPE, id, content, this.me, Date.now())]);
        return id;
    }

    async rename(id: string, name: string): Promise<void> {
        const inst = this.instances.get(id);
        if (!inst || !this.api) return;
        const content = { ...inst.content, name: name.trim().slice(0, 100) || inst.content.name };
        await this.api.sendStateEvent(INSTANCE_TYPE, id, content);
        this.onState([localState(INSTANCE_TYPE, id, content, inst.sender, inst.ts)]);
    }

    /** Removes the app from the room (and its tile). Updates already sent stay in the timeline. */
    async remove(id: string): Promise<void> {
        if (!this.api) return;
        if (this.pinned.has(id)) await this.unpin(id);
        await this.api.sendStateEvent(INSTANCE_TYPE, id, {});
        this.instances.delete(id);
        this.onChange();
    }

    /** Adds the app as its own room widget: this bundle in single-app mode. */
    async pin(id: string, widgetUrl: string): Promise<void> {
        const inst = this.instances.get(id);
        if (!inst || !this.api) return;
        const stateKey = `${PIN_PREFIX}${id}`;
        await this.api.sendStateEvent(WIDGET_TYPE, stateKey, {
            type: WIDGET_KIND,
            url: widgetUrl,
            name: inst.content.name,
            creatorUserId: this.me,
            waitForIframeLoad: true,
            ...(inst.content.icon ? { avatar_url: inst.content.icon } : {}),
            data: { title: inst.content.name, instance: id },
        });
        this.pinned.set(id, stateKey);
        this.onChange();
    }

    async unpin(id: string): Promise<void> {
        const stateKey = this.pinned.get(id);
        if (!stateKey || !this.api) return;
        await this.api.sendStateEvent(WIDGET_TYPE, stateKey, {});
        this.pinned.delete(id);
        this.onChange();
    }

    // ---- sendToChat (src/chat.ts) -------------------------------------------

    sendToChat(message: ChatMessage): Promise<void> {
        return sendToChat({ api: this.api, encrypted: this.encrypted, addInstance: (xdc, bytes) => this.addInstance(xdc, bytes), sendEvent: (t, c) => this.sendWithRetry(t, c) }, message);
    }

    // ---- Realtime (src/realtime.ts) -----------------------------------------

    joinRealtime(instance: string, onData: (data: Uint8Array) => void): Channel {
        return this.rt.join(instance, onData);
    }

    onToDevice(ev: { type: string; sender: string; content: unknown }): void {
        this.rt.onToDevice(ev);
    }
}

export { LOCAL_PREFIX };

/** Our own state write, applied before the host echoes it. */
function localState(type: string, stateKey: string, content: unknown, sender: string, ts: number): IRoomEvent {
    return { type, state_key: stateKey, content, sender, origin_server_ts: ts, event_id: "", room_id: "", unsigned: {} } as IRoomEvent;
}

function oneLine(text: string, max: number): string {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
