/*
 * The .xdc container: a zip with index.html, optionally manifest.toml (name,
 * source_code_url) and icon.png / icon.jpg. https://webxdc.org/docs/spec/format.html
 */
import { unzipSync } from "fflate";
import { sha256Hex } from "./crypto";

export interface XdcFile {
    path: string;
    bytes: Uint8Array<ArrayBuffer>;
}

export interface Xdc {
    name: string;
    sourceCodeUrl?: string;
    icon?: { bytes: Uint8Array<ArrayBuffer>; type: string };
    files: XdcFile[];
    size: number;
    sha256: string;
}

/** Larger archives are refused: they would not fit the media repo or the browser's patience. */
export const MAX_XDC_SIZE = 50 * 1024 * 1024;
const MAX_UNPACKED = 200 * 1024 * 1024;

export async function parseXdc(bytes: Uint8Array<ArrayBuffer>, fallbackName = "webxdc app"): Promise<Xdc> {
    if (bytes.byteLength > MAX_XDC_SIZE) throw new Error("This app is larger than 50 MB");
    let entries: Record<string, Uint8Array>;
    try {
        let total = 0;
        entries = unzipSync(bytes, {
            filter: (f) => {
                total += f.originalSize;
                if (total > MAX_UNPACKED) throw new Error("This app unpacks to more than 200 MB");
                return !f.name.endsWith("/");
            },
        });
    } catch (err) {
        throw new Error(err instanceof Error && err.message.includes("200 MB") ? err.message : "This is not a valid .xdc file (not a zip archive)");
    }

    const files: XdcFile[] = [];
    for (const [raw, data] of Object.entries(entries)) {
        const path = normalisePath(raw);
        if (path) files.push({ path, bytes: new Uint8Array(data) });
    }
    const byPath = new Map(files.map((f) => [f.path, f]));
    if (!byPath.has("index.html")) throw new Error("This is not a webxdc app: index.html is missing");

    const manifest = byPath.get("manifest.toml");
    const fields = manifest ? parseManifest(new TextDecoder().decode(manifest.bytes)) : {};
    const png = byPath.get("icon.png");
    const jpg = byPath.get("icon.jpg");

    return {
        name: (fields.name ?? "").trim() || fallbackName,
        sourceCodeUrl: safeHttpUrl(fields.source_code_url),
        icon: png ? { bytes: png.bytes, type: "image/png" } : jpg ? { bytes: jpg.bytes, type: "image/jpeg" } : undefined,
        files,
        size: bytes.byteLength,
        sha256: await sha256Hex(bytes),
    };
}

/** Zip names are untrusted: no absolute paths, no `..`, forward slashes only. */
export function normalisePath(raw: string): string | null {
    const parts: string[] = [];
    for (const part of raw.replace(/\\/g, "/").split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") return null;
        parts.push(part);
    }
    return parts.length ? parts.join("/") : null;
}

/**
 * The manifest fields the spec defines are flat `key = "string"` pairs; this
 * reads those and ignores tables and everything else rather than pulling in a
 * TOML parser.
 */
export function parseManifest(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*\[/.test(line)) break; // the first table ends the top level
        const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(#.*)?$/.exec(line);
        if (!m) continue;
        const value = m[2];
        out[m[1]] = value.startsWith("'") ? value.slice(1, -1) : (JSON.parse(value) as string);
    }
    return out;
}

export function safeHttpUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
    } catch {
        return undefined;
    }
}

/** A readable name from a file name: "chess-v1.2.xdc" → "chess-v1.2". */
export function nameFromFile(fileName: string): string {
    return fileName.replace(/\.xdc$/i, "").trim() || "webxdc app";
}
