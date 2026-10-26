/*
 * One running app: the runner frame on its own origin, and the MessagePort its
 * webxdc.js talks through. See runner/boot.js and runner/shim.js for the other end.
 *
 *   widget                         runner frame
 *   frame.src = boot.html#…   →    registers sw.js
 *                             ←    {xdc:"boot"}
 *   {xdc:"load", files, meta} →    caches files, navigates to app/<key>/index.html
 *                             ←    {xdc:"hello"} (webxdc.js, on every page load)
 *   {xdc:"port"} + MessagePort →   all API calls over the port
 */
import { sha256Hex } from "./crypto";
import type { LogEntry } from "./log";
import { SEND_UPDATE_INTERVAL, SEND_UPDATE_MAX_SIZE, type Instance, type Room } from "./room";

export interface ToChatMessage {
    text?: string;
    file?: { name: string; blob: Blob; type?: string };
}

export interface SessionOptions {
    room: Room;
    instance: Instance;
    frame: HTMLIFrameElement;
    /** Runner base URL, ending in "/". May contain "{key}" for one origin per instance. */
    runner: string;
    selfName: string;
    /** In-app location to open (update.href), relative to the app root. */
    href?: string;
    /** The user must confirm before anything leaves the app. */
    confirmLink(url: string): void;
    confirmToChat(message: ToChatMessage): Promise<boolean>;
    onError(message: string): void;
    onStatus?(status: "loading" | "running"): void;
}

/** Same app in the same instance → same key → same cached files and storage on the runner. */
export async function instanceKey(instance: Instance): Promise<string> {
    return (await sha256Hex(new TextEncoder().encode(`${instance.id}:${instance.content.sha256}`))).slice(0, 32);
}

export function runnerUrlFor(runner: string, key: string): string {
    return runner.includes("{key}") ? runner.replace("{key}", key) : runner;
}

export class AppSession {
    private port: MessagePort | null = null;
    private unsubscribe: (() => void) | null = null;
    private realtime: { send(data: Uint8Array): void; leave(): void } | null = null;
    private key = "";
    private runnerOrigin = "";
    private stopped = false;
    private readonly onWindowMessage = (e: MessageEvent) => void this.onFrameMessage(e);

    constructor(private o: SessionOptions) {}

    async start(): Promise<void> {
        this.key = await instanceKey(this.o.instance);
        const base = runnerUrlFor(this.o.runner, this.key);
        this.runnerOrigin = new URL(base).origin;
        if (this.runnerOrigin === window.location.origin) {
            this.o.onError("The runner is on the widget's own origin, which would let apps reach the room. Configure a separate runner origin.");
            return;
        }
        this.o.onStatus?.("loading");
        window.addEventListener("message", this.onWindowMessage);
        const fragment = new URLSearchParams({ parent: window.location.origin, key: this.key });
        if (this.o.href) fragment.set("href", this.o.href);
        this.o.frame.src = `${new URL("boot.html", base).href}#${fragment}`;
    }

    stop(): void {
        this.stopped = true;
        window.removeEventListener("message", this.onWindowMessage);
        this.unsubscribe?.();
        this.realtime?.leave();
        this.port?.close();
        this.port = null;
    }

    private async onFrameMessage(e: MessageEvent): Promise<void> {
        if (this.stopped || e.source !== this.o.frame.contentWindow || e.origin !== this.runnerOrigin || !e.data) return;
        const m = e.data as { xdc?: string; key?: string; message?: string };
        switch (m.xdc) {
            case "boot":
                if (m.key === this.key) await this.load();
                break;
            case "hello":
                if (m.key === this.key) this.connect();
                break;
            case "boot-error":
                this.o.onError(m.message ?? "The runner could not start the app.");
                break;
        }
    }

    /** Always sends the files: they come from this widget's cache, checked against the room's hash; the runner's cache is not trusted. */
    private async load(): Promise<void> {
        const { room, instance } = this.o;
        let files: [string, ArrayBuffer][];
        try {
            const { xdc } = await room.loadXdc(instance);
            files = xdc.files.map((f) => [f.path, f.bytes.buffer]);
        } catch (err) {
            this.o.onError(err instanceof Error ? err.message : String(err));
            return;
        }
        if (this.stopped) return;
        const meta = {
            selfAddr: await room.addr(room.me, instance.id),
            selfName: this.o.selfName,
            isAppSender: instance.sender === room.me,
            isBroadcast: false,
            sendUpdateInterval: SEND_UPDATE_INTERVAL,
            sendUpdateMaxSize: SEND_UPDATE_MAX_SIZE,
            realtime: room.live,
            // One origin for all apps: keep their storage apart by name at least.
            isolateStorage: !this.o.runner.includes("{key}"),
        };
        // Apps that never load webxdc.js (no "hello") still run: the app page's
        // load event, the next one after the files are sent, marks the session running.
        this.o.frame.addEventListener("load", () => this.stopped || this.o.onStatus?.("running"), { once: true });
        this.o.frame.contentWindow?.postMessage(
            { xdc: "load", key: this.key, files, meta },
            this.runnerOrigin,
            files.map(([, b]) => b),
        );
    }

    /** A page of the app loaded webxdc.js: give it a fresh port (the old page is gone). */
    private connect(): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.realtime?.leave();
        this.realtime = null;
        this.port?.close();
        const channel = new MessageChannel();
        this.port = channel.port1;
        const port = channel.port1;
        port.onmessage = (ev) => void this.onAppMessage(port, ev.data);
        this.o.frame.contentWindow?.postMessage({ xdc: "port" }, this.runnerOrigin, [channel.port2]);
        this.o.onStatus?.("running");
    }

    private async onAppMessage(port: MessagePort, m: { t?: string; id?: number; serial?: number; update?: unknown; message?: ToChatMessage; url?: string; data?: ArrayBuffer }): Promise<void> {
        if (port !== this.port || !m || typeof m.t !== "string") return;
        const { room, instance } = this.o;
        const reply = (value?: unknown, error?: string) => port.postMessage({ t: "reply", id: m.id, value, error });

        switch (m.t) {
            case "listen": {
                const log = await room.log(instance.id);
                if (port !== this.port) return;
                // Replay and subscribe in the same tick, so nothing slips between them.
                this.unsubscribe?.();
                const max = log.maxSerial;
                for (const e of log.after(Number(m.serial) || 0)) port.postMessage({ t: "update", update: toApp(e, max) });
                port.postMessage({ t: "listen-done" });
                this.unsubscribe = room.subscribe(instance.id, (e, maxSerial) => port.postMessage({ t: "update", update: toApp(e, maxSerial) }));
                break;
            }
            case "send":
                room.send(instance.id, m.update as never).catch((err) => this.o.onError(`The app sent an update that was refused: ${err instanceof Error ? err.message : err}`));
                break;
            case "all": {
                const log = await room.log(instance.id);
                reply(log.entries.map((e) => toApp(e, log.maxSerial)));
                break;
            }
            case "toChat": {
                const message = m.message ?? {};
                try {
                    if (!(await this.o.confirmToChat(message))) return reply(undefined);
                    await room.sendToChat(message);
                    reply(undefined);
                } catch (err) {
                    reply(undefined, err instanceof Error ? err.message : String(err));
                }
                break;
            }
            case "link":
                if (typeof m.url === "string") this.o.confirmLink(m.url);
                break;
            case "rt-join":
                this.realtime?.leave();
                this.realtime = room.joinRealtime(instance.id, (data) => {
                    if (port === this.port) port.postMessage({ t: "rt-data", data: data.slice().buffer }, []);
                });
                break;
            case "rt-send":
                if (this.realtime && m.data instanceof ArrayBuffer) this.realtime.send(new Uint8Array(m.data));
                break;
            case "rt-leave":
                this.realtime?.leave();
                this.realtime = null;
                break;
        }
    }
}

/** The update object an app's listener receives (spec: setUpdateListener). */
export function toApp(e: LogEntry, maxSerial: number): Record<string, unknown> {
    const u = e.update;
    const out: Record<string, unknown> = { payload: u.payload, serial: e.serial, max_serial: maxSerial };
    if (u.info) out.info = u.info;
    if (u.href) out.href = u.href;
    if (u.document) out.document = u.document;
    if (u.summary) out.summary = u.summary;
    return out;
}
