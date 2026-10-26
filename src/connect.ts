/*
 * Widget bootstrap over plain matrix-widget-api, for hosts that enforce consent
 * (Marcade Player strict mode) and for Element Web/Desktop. Adapted from
 * widget-builder; the comments say which host behaviour each step is for.
 */
import {
    EventDirection,
    MatrixCapabilities,
    WidgetApi,
    WidgetApiToWidgetAction,
    WidgetEventCapability,
    type Capability,
    type IRoomEvent,
    type IWidgetApiRequest,
} from "matrix-widget-api";
import { INSTANCE_TYPE, REALTIME_TYPE, SYNC_TYPE, UPDATE_TYPE, WIDGET_TYPE } from "./events";

/** Parameters may arrive in the query (host-appended) or the fragment (ours). */
export interface Params {
    get(name: string): string | null;
}

export function readParams(search = window.location.search, hash = window.location.hash): Params {
    const query = new URLSearchParams(search);
    const q = hash.indexOf("?");
    const fragment = new URLSearchParams(q === -1 ? "" : hash.slice(q));
    // Fragment wins: it is where we put our own config, and it never reaches the
    // server hosting the widget. Reading only one source masks the other and the
    // handshake hangs (no parentUrl ⇒ untargeted postMessage).
    return { get: (name) => fragment.get(name) ?? query.get(name) };
}

export const UPLOAD_FILE = "org.matrix.msc4039.upload_file" as Capability;
export const DOWNLOAD_FILE = "org.matrix.msc4039.download_file" as Capability;

const state = (dir: EventDirection, type: string, key?: string) => WidgetEventCapability.forStateEvent(dir, type, key).raw as Capability;
const room = (dir: EventDirection, type: string) => WidgetEventCapability.forRoomEvent(dir, type).raw as Capability;
const message = (dir: EventDirection, msgtype: string) => WidgetEventCapability.forRoomMessageEvent(dir, msgtype).raw as Capability;
const toDevice = (dir: EventDirection, type: string) => WidgetEventCapability.forToDeviceEvent(dir, type).raw as Capability;

/**
 * The library (no `instance`) lists, adds, pins and removes apps. A pinned tile
 * (`instance` set) plays one app and may read only that app's state event.
 */
export function capabilitiesFor(instance: string | null): Capability[] {
    const play = [
        // Updates and history sync: timeline events, encrypted in E2EE rooms, and
        // every member may send them.
        room(EventDirection.Send, UPDATE_TYPE),
        room(EventDirection.Receive, UPDATE_TYPE),
        room(EventDirection.Send, SYNC_TYPE),
        room(EventDirection.Receive, SYNC_TYPE),
        // Large updates and history go through the media repo, encrypted in-widget;
        // the .xdc itself is downloaded from there.
        UPLOAD_FILE,
        DOWNLOAD_FILE,
        // update.info / update.notify as a notice; sendToChat() after the user confirms.
        message(EventDirection.Send, "m.notice"),
        message(EventDirection.Send, "m.text"),
        message(EventDirection.Send, "m.file"),
        message(EventDirection.Send, "m.image"),
        // Encrypt sendToChat() files when the room is encrypted.
        state(EventDirection.Receive, "m.room.encryption"),
        // Display names for notify, and the recipients of realtime data.
        state(EventDirection.Receive, "m.room.member"),
        toDevice(EventDirection.Send, REALTIME_TYPE),
        toDevice(EventDirection.Receive, REALTIME_TYPE),
    ];
    // Useless outside a client: it has no session of its own. Auto-granted by
    // Element and the Player; hides Element's "pop out" button.
    const base = [MatrixCapabilities.RequiresClient as Capability];
    if (instance) return [...base, state(EventDirection.Receive, INSTANCE_TYPE, instance), ...play];
    return [
        ...base,
        // Apps in the room: one state event each. Adding one needs the room's state
        // power level, like adding a widget.
        state(EventDirection.Send, INSTANCE_TYPE),
        state(EventDirection.Receive, INSTANCE_TYPE),
        // Pinning an app as its own room widget.
        state(EventDirection.Send, WIDGET_TYPE),
        state(EventDirection.Receive, WIDGET_TYPE),
        ...play,
    ];
}

export interface Connection {
    api: WidgetApi;
    /** Capabilities the host actually approved (empty until `ready`). */
    approved: Capability[];
}

export interface Handlers {
    onState?: (events: IRoomEvent[]) => void;
    onEvent?: (event: IRoomEvent) => void;
    onToDevice?: (event: { type: string; sender: string; content: unknown }) => void;
    onTheme?: (theme: string) => void;
}

/**
 * Returns null when the page is not framed by a client. Otherwise resolves once
 * the host has answered the capability request, or after `timeoutMs`.
 */
export async function connect(params: Params, capabilities: Capability[], handlers: Handlers = {}, timeoutMs = 60_000): Promise<Connection | null> {
    const widgetId = params.get("widgetId") ?? params.get("matrix_widget_id");
    const parentUrl = params.get("parentUrl");
    const embedded = !!widgetId && window.parent !== window;
    if (!embedded) return null;

    // Element Desktop frames widgets from vector://vector, whose origin is the
    // literal string "null". Treat that as unknown and let the SDK post to "*".
    let origin: string | null = null;
    try {
        if (parentUrl) {
            const o = new URL(parentUrl).origin;
            origin = o !== "null" ? o : null;
        }
    } catch {
        /* keep null */
    }

    const api = new WidgetApi(widgetId!, origin);

    // Every capability before start(): the Player has no MSC2974 renegotiation.
    for (const c of capabilities) api.requestCapability(c);

    const ack = (ev: CustomEvent<IWidgetApiRequest>): void => {
        ev.preventDefault();
        api.transport.reply(ev.detail, {});
    };

    api.on(`action:${WidgetApiToWidgetAction.UpdateState}`, (ev: CustomEvent<IWidgetApiRequest>) => {
        ack(ev);
        handlers.onState?.((ev.detail.data as { state?: IRoomEvent[] }).state ?? []);
    });
    api.on(`action:${WidgetApiToWidgetAction.SendEvent}`, (ev: CustomEvent<IWidgetApiRequest>) => {
        ack(ev);
        handlers.onEvent?.(ev.detail.data as unknown as IRoomEvent);
    });
    api.on(`action:${WidgetApiToWidgetAction.SendToDevice}`, (ev: CustomEvent<IWidgetApiRequest>) => {
        ack(ev);
        handlers.onToDevice?.(ev.detail.data as unknown as { type: string; sender: string; content: unknown });
    });
    api.on(`action:${WidgetApiToWidgetAction.ThemeChange}`, (ev: CustomEvent<IWidgetApiRequest>) => {
        ack(ev);
        const name = (ev.detail.data as { name?: string }).name;
        if (name) handlers.onTheme?.(name);
    });
    api.on(`action:${WidgetApiToWidgetAction.LanguageChange}`, ack);
    api.on(`action:${WidgetApiToWidgetAction.WidgetConfig}`, ack);
    api.on(`action:${WidgetApiToWidgetAction.UpdateVisibility}`, ack);

    // The default 10 s is short when a human is answering a dialog on the other side.
    api.transport.timeoutSeconds = 30;

    const approved: Capability[] = [];
    // hasCapability() falls back to the *requested* list until the host has
    // notified, so read the approved set off the event instead.
    api.once("action:notify_capabilities", (ev: CustomEvent<IWidgetApiRequest>) => {
        approved.push(...((ev.detail.data as { approved?: Capability[] }).approved ?? []));
    });

    api.start();
    api.sendContentLoaded().catch(() => undefined);

    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        api.once("ready", () => {
            clearTimeout(timer);
            resolve();
        });
    });

    // The Player mounts the widget once before consent (everything denied), then
    // remounts it with the approved set. Nothing irreversible happens before this.
    return { api, approved };
}

/** Initial theme: the URL hint first, then the system preference. */
export function initialTheme(params: Params): "light" | "dark" {
    const hint = params.get("theme");
    if (hint?.startsWith("dark")) return "dark";
    if (hint?.startsWith("light")) return "light";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
