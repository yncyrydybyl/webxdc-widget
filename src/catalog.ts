/*
 * App catalogs in the xdcget export format: the list webxdc.org/apps shows
 * (https://apps.testrun.org/xdcget-lock.json, CORS open) or a self-hosted export.
 * Each entry points at a cached .xdc and an icon next to the JSON file.
 */
import { MAX_XDC_SIZE } from "./xdc";

export const DEFAULT_CATALOG = "https://apps.testrun.org/xdcget-lock.json";

export interface CatalogApp {
    app_id: string;
    name: string;
    description: string;
    category: string;
    tag_name: string;
    date: string;
    size: number;
    source_code_url?: string;
    /** Absolute URLs, resolved against the catalog. */
    xdcUrl: string;
    iconUrl?: string;
}

interface RawEntry {
    app_id?: unknown;
    name?: unknown;
    description?: unknown;
    category?: unknown;
    tag_name?: unknown;
    date?: unknown;
    size?: unknown;
    source_code_url?: unknown;
    cache_relname?: unknown;
    icon_relname?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function parseCatalog(json: unknown, catalogUrl: string): CatalogApp[] {
    if (!Array.isArray(json)) throw new Error("This catalog is not a list of apps");
    const base = new URL(".", catalogUrl);
    const out: CatalogApp[] = [];
    for (const raw of json as RawEntry[]) {
        const cache = str(raw?.cache_relname);
        const name = str(raw?.name);
        if (!cache || !name) continue;
        const xdc = new URL(cache, base);
        if (xdc.protocol !== "https:" && xdc.protocol !== "http:") continue;
        const icon = str(raw.icon_relname);
        out.push({
            app_id: str(raw.app_id) || cache,
            name,
            description: str(raw.description),
            category: str(raw.category) || "other",
            tag_name: str(raw.tag_name),
            date: str(raw.date),
            size: typeof raw.size === "number" ? raw.size : 0,
            source_code_url: str(raw.source_code_url) || undefined,
            xdcUrl: xdc.href,
            iconUrl: icon ? new URL(icon, base).href : undefined,
        });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadCatalog(url: string): Promise<CatalogApp[]> {
    const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error(`The catalog answered ${res.status}`);
    return parseCatalog(await res.json(), url);
}

/** The first paragraph or line: catalog descriptions repeat the name and run long. */
export function shortDescription(description: string): string {
    const lines = description.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[0] ?? "";
}

export function matches(app: CatalogApp, query: string, category: string): boolean {
    if (category && app.category !== category) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return app.name.toLowerCase().includes(q) || app.description.toLowerCase().includes(q);
}

/** Downloads an .xdc over https. Fails for hosts without CORS (most release pages); the UI then suggests the file picker. */
export async function downloadXdc(url: string): Promise<Uint8Array<ArrayBuffer>> {
    let res: Response;
    try {
        res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
    } catch {
        throw new Error("The download was refused (the server does not allow it from a web page). Download the .xdc and pick it as a file instead.");
    }
    if (!res.ok) throw new Error(`The download failed (${res.status})`);
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > MAX_XDC_SIZE) throw new Error("This app is larger than 50 MB");
    return new Uint8Array(await res.arrayBuffer());
}
