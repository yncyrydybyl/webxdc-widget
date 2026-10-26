/*
 * The update log of each app instance on this device.
 *
 * webxdc apps replay every update after a serial they remember, so serials must
 * be stable across reloads: an update gets its serial the first time this
 * device sees it, and keeps it. The order is this device's arrival order, as in
 * Delta Chat; apps are written for that.
 *
 * Kept in IndexedDB because a widget can read back only ~20–50 recent timeline
 * events: without this copy an app would forget everything older on reload.
 * Downloaded .xdc files are cached here too, by SHA-256.
 */
import type { WebxdcUpdate } from "./events";

export interface LogEntry {
    /** The sender's random id: the same update arriving twice (echo, history sync) is kept once. */
    id: string;
    sender: string;
    ts: number;
    serial: number;
    update: WebxdcUpdate;
}

interface StoredEntry extends LogEntry {
    k: string;
    instance: string;
}

interface InstanceMeta {
    instance: string;
    nextSerial: number;
    /** Asked the room for history once already. */
    synced: boolean;
}

const DB_NAME = "webxdc-widget";
const DB_VERSION = 1;

function promisify<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** null when IndexedDB is unavailable (private mode, blocked storage): the log then lives in memory only. */
function db(): Promise<IDBDatabase | null> {
    dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
        try {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const d = req.result;
                d.createObjectStore("entries", { keyPath: "k" }).createIndex("instance", "instance");
                d.createObjectStore("meta", { keyPath: "instance" });
                d.createObjectStore("blobs");
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
    return dbPromise;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    const d = await db();
    if (!d) return undefined;
    try {
        return await promisify(fn(d.transaction(store, mode).objectStore(store)));
    } catch {
        return undefined;
    }
}

export class InstanceLog {
    readonly instance: string;
    entries: LogEntry[] = [];
    synced = false;
    private ids = new Set<string>();
    private nextSerial = 1;

    private constructor(instance: string) {
        this.instance = instance;
    }

    static async open(instance: string): Promise<InstanceLog> {
        const log = new InstanceLog(instance);
        const stored = (await tx("entries", "readonly", (s) => s.index("instance").getAll(instance))) as StoredEntry[] | undefined;
        const meta = (await tx("meta", "readonly", (s) => s.get(instance))) as InstanceMeta | undefined;
        for (const e of (stored ?? []).sort((a, b) => a.serial - b.serial)) {
            log.entries.push({ id: e.id, sender: e.sender, ts: e.ts, serial: e.serial, update: e.update });
            log.ids.add(e.id);
        }
        log.nextSerial = Math.max(meta?.nextSerial ?? 1, (log.entries.at(-1)?.serial ?? 0) + 1);
        log.synced = meta?.synced ?? false;
        return log;
    }

    get maxSerial(): number {
        return this.entries.at(-1)?.serial ?? 0;
    }

    get count(): number {
        return this.entries.length;
    }

    has(id: string): boolean {
        return this.ids.has(id);
    }

    /** Appends unless already known; returns the new entry or null. */
    add(entry: Omit<LogEntry, "serial">): LogEntry | null {
        if (this.ids.has(entry.id)) return null;
        const full: LogEntry = { ...entry, serial: this.nextSerial++ };
        this.ids.add(full.id);
        this.entries.push(full);
        void tx("entries", "readwrite", (s) => s.put({ ...full, k: `${this.instance}|${full.id}`, instance: this.instance } satisfies StoredEntry));
        void this.saveMeta();
        return full;
    }

    after(serial: number): LogEntry[] {
        // Entries are sorted by serial; most listeners ask for the tail.
        let i = this.entries.length;
        while (i > 0 && this.entries[i - 1].serial > serial) i--;
        return this.entries.slice(i);
    }

    /** The newest value of a display field (summary, document), as Delta Chat shows it. */
    latest(field: "summary" | "document"): string | undefined {
        for (let i = this.entries.length - 1; i >= 0; i--) {
            const v = this.entries[i].update[field];
            if (typeof v === "string" && v) return v;
        }
        return undefined;
    }

    markSynced(): void {
        this.synced = true;
        void this.saveMeta();
    }

    private saveMeta(): Promise<unknown> {
        return tx("meta", "readwrite", (s) => s.put({ instance: this.instance, nextSerial: this.nextSerial, synced: this.synced } satisfies InstanceMeta));
    }
}

/** For when IndexedDB is unavailable: this page's downloads and local apps. */
const memoryBlobs = new Map<string, Uint8Array<ArrayBuffer>>();

export async function getBlob(sha256: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const mem = memoryBlobs.get(sha256);
    if (mem) return mem;
    const v = await tx("blobs", "readonly", (s) => s.get(sha256));
    return v instanceof Uint8Array ? (v as Uint8Array<ArrayBuffer>) : v instanceof ArrayBuffer ? new Uint8Array(v) : undefined;
}

export async function putBlob(sha256: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if ((await db()) === null) memoryBlobs.set(sha256, bytes);
    await tx("blobs", "readwrite", (s) => s.put(bytes, sha256));
}

/** Tests: a fresh database, as on another device. */
export function resetStorageForTests(): void {
    dbPromise = null;
    memoryBlobs.clear();
}
