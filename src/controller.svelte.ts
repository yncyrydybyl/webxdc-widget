/*
 * The widget's state: connection to the host, the room's apps, and what is on
 * screen. Views read `version` (through the getters) to re-render when the room
 * changes; the Room itself is plain TypeScript.
 */
import type { Capability, IRoomEvent } from "matrix-widget-api";
import type { ToChatMessage } from "./bridge";
import { DEFAULT_CATALOG } from "./catalog";
import { capabilitiesFor, connect, initialTheme, readParams } from "./connect";
import { INSTANCE_TYPE, WIDGET_TYPE } from "./events";
import type { InstanceLog } from "./log";
import { localpart, Room, type Instance, type RoomApi } from "./room";

export type View = { name: "library" } | { name: "add" } | { name: "player"; instance: string; href?: string };

const LOCAL_USER = "@you:local";
const IDENTITY_TEMPLATE = "matrix_user_id=$matrix_user_id&matrix_display_name=$matrix_display_name&theme=$org.matrix.msc2873.client_theme";

/** Appends the identity template variables to a widget URL's fragment parameters. */
export function withIdentityTemplate(url: string): string {
    const hash = url.indexOf("#");
    if (hash === -1) return `${url}#/?${IDENTITY_TEMPLATE}`;
    return url.indexOf("?", hash) === -1 ? `${url}?${IDENTITY_TEMPLATE}` : `${url}&${IDENTITY_TEMPLATE}`;
}

/** Development default: a second origin on the same machine (scripts/dev.mjs serves runner/ there). */
const DEFAULT_RUNNER = (import.meta.env.VITE_RUNNER_URL as string | undefined) ?? "http://127.0.0.1:5174/";

export class Controller {
    readonly params = readParams();
    /** A pinned tile plays this one app; the library is not shown. */
    readonly only = this.params.get("instance");
    /**
     * Who is using the widget. Comes from the URL ($matrix_user_id): the Widget API
     * has no other way to tell. Store installs use a bare URL, so the widget may
     * have to add the template variables to its own widget event first (fixIdentity).
     */
    readonly userId = this.params.get("matrix_user_id") ?? this.params.get("userId");
    readonly widgetId = this.params.get("widgetId") ?? this.params.get("matrix_widget_id");
    readonly runner = this.params.get("runner") ?? DEFAULT_RUNNER;
    readonly catalogUrl = this.params.get("catalog") ?? DEFAULT_CATALOG;
    private readonly displayNameParam = this.params.get("matrix_display_name") ?? this.params.get("displayName");

    theme = $state<"light" | "dark">(initialTheme(this.params));
    status = $state<"connecting" | "ready" | "standalone">("connecting");
    view = $state<View>(this.only ? { name: "player", instance: this.only } : { name: "library" });
    notice = $state("");
    /** Bumped whenever the room changes. */
    version = $state(0);
    approved = $state<Capability[]>([]);
    /** known: apps can start. fixing: our widget event was rewritten, the client reloads us. missing: nothing we can do. */
    identity = $state<"known" | "fixing" | "missing">(this.userId ? "known" : "missing");

    /** Dialogs: an app wants to open a link / send to the chat. */
    linkToConfirm = $state<string | null>(null);
    chatToConfirm = $state<{ message: ToChatMessage; resolve: (ok: boolean) => void } | null>(null);

    readonly room = new Room(null, this.userId ?? LOCAL_USER, this.only);
    private logs = new Map<string, InstanceLog>();

    constructor() {
        this.room.onChange = () => {
            this.version++;
            void this.openLogs();
        };
        this.room.onError = (m) => (this.notice = m);
    }

    async start(): Promise<void> {
        document.documentElement.dataset.theme = this.theme;
        const conn = await connect(this.params, capabilitiesFor(this.only), {
            onState: (events) => this.room.onState(events),
            onEvent: (ev: IRoomEvent) => void this.room.onEvent(ev),
            onToDevice: (ev) => this.room.onToDevice(ev),
            onTheme: (name) => {
                this.theme = name.startsWith("dark") ? "dark" : "light";
                document.documentElement.dataset.theme = this.theme;
            },
        });
        if (!conn) {
            this.status = "standalone";
            this.identity = "known"; // a local user: nothing leaves the page
            return;
        }
        this.approved = conn.approved;
        this.room.attach(conn.api as unknown as RoomApi);
        this.status = "ready";
        await this.room.readInitialState();
        if (!this.userId) await this.fixIdentity(conn.api as unknown as RoomApi);
        await this.room.backfill();
        this.version++;
    }

    /**
     * Opened from a bare URL (the store's /addwidget line, the store widget, the
     * Player): add $matrix_user_id and friends to our own widget event, once.
     * The client then reloads the widget with the values filled in for each
     * viewer. Needs the right to change widgets, which whoever added it has.
     * Without an identity, apps do not start: every user would get the same
     * selfAddr.
     */
    private async fixIdentity(api: RoomApi): Promise<void> {
        if (!this.widgetId || !this.canPin) return;
        let own: IRoomEvent | undefined;
        try {
            own = (await api.readStateEvents(WIDGET_TYPE, 1, this.widgetId)).find((e) => e.state_key === this.widgetId);
        } catch {
            return;
        }
        const content = own?.content as Record<string, unknown> | undefined;
        const url = typeof content?.url === "string" ? content.url : null;
        if (!url || url.includes("matrix_user_id")) return;
        try {
            await api.sendStateEvent(WIDGET_TYPE, this.widgetId, {
                ...content,
                url: withIdentityTemplate(url),
                // Element names a pasted URL "Custom".
                ...(typeof content!.name !== "string" || !content!.name.trim() || content!.name === "Custom" ? { name: "webxdc apps" } : {}),
            });
            this.identity = "fixing";
        } catch {
            /* no power level: stays "missing" */
        }
    }

    // ---- Room data for the views -------------------------------------------

    get instances(): Instance[] {
        void this.version;
        return [...this.room.instances.values()].sort((a, b) => a.content.name.localeCompare(b.content.name));
    }

    instance(id: string): Instance | undefined {
        void this.version;
        return this.room.instances.get(id) ?? this.room.locals.get(id);
    }

    /** "8 votes" / the document name, as the app last set it. */
    caption(id: string): string {
        void this.version;
        const log = this.logs.get(id);
        if (!log) return "";
        return [log.latest("document"), log.latest("summary")].filter(Boolean).join(" · ");
    }

    /** The latest info messages that point into the app (update.href), newest first: Delta Chat opens the app there on a tap. */
    links(id: string, max = 3): { info: string; href: string; sender: string }[] {
        void this.version;
        const out: { info: string; href: string; sender: string }[] = [];
        const entries = this.logs.get(id)?.entries ?? [];
        for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
            const { info, href } = entries[i].update;
            if (info && href) out.push({ info, href, sender: entries[i].sender });
        }
        return out;
    }

    isPinned(id: string): boolean {
        void this.version;
        return this.room.pinned.has(id);
    }

    get encrypted(): boolean {
        void this.version;
        return this.room.encrypted;
    }

    get selfName(): string {
        void this.version;
        return this.room.members.get(this.room.me) ?? this.displayNameParam ?? localpart(this.room.me);
    }

    get canPlay(): boolean {
        return this.identity === "known";
    }

    /** The /addwidget line that carries the identity, for someone who re-adds the widget. */
    get addWidgetLine(): string {
        return `/addwidget ${withIdentityTemplate(window.location.href.split("#")[0].split("?")[0])}`;
    }

    private async openLogs(): Promise<void> {
        let opened = false;
        for (const id of this.room.instances.keys()) {
            if (this.logs.has(id)) continue;
            this.logs.set(id, await this.room.log(id));
            opened = true;
        }
        if (opened) this.version++;
    }

    // ---- Permissions --------------------------------------------------------

    can(capability: string): boolean {
        return this.status === "ready" && this.approved.includes(capability as Capability);
    }

    get canAdd(): boolean {
        return this.can(`org.matrix.msc2762.send.state_event:${INSTANCE_TYPE}`) && this.can("org.matrix.msc4039.upload_file");
    }

    get canPin(): boolean {
        return this.can(`org.matrix.msc2762.send.state_event:${WIDGET_TYPE}`);
    }

    // ---- Actions ------------------------------------------------------------

    open(view: View): void {
        this.view = view;
    }

    async attempt(what: string, fn: () => Promise<unknown>): Promise<boolean> {
        try {
            await fn();
            return true;
        } catch (err) {
            this.notice = `${what}: ${err instanceof Error ? err.message : String(err)}`;
            return false;
        }
    }

    /** The URL a pinned tile loads: this bundle in single-app mode. Element fills in the $ variables. */
    tileUrl(id: string): string {
        const base = window.location.href.split("#")[0].split("?")[0];
        const frag = new URLSearchParams({ instance: id });
        if (this.params.get("runner")) frag.set("runner", this.runner);
        return `${base}#/?${frag}&matrix_user_id=$matrix_user_id&matrix_display_name=$matrix_display_name&theme=$org.matrix.msc2873.client_theme`;
    }

    confirmToChat(message: ToChatMessage): Promise<boolean> {
        this.chatToConfirm?.resolve(false);
        return new Promise((resolve) => (this.chatToConfirm = { message, resolve }));
    }

    answerChat(ok: boolean): void {
        this.chatToConfirm?.resolve(ok);
        this.chatToConfirm = null;
    }

    confirmLink(url: string): void {
        this.linkToConfirm = url;
    }

    answerLink(open: boolean): void {
        const url = this.linkToConfirm;
        this.linkToConfirm = null;
        if (open && url) window.open(url, "_blank", "noopener,noreferrer");
    }
}
