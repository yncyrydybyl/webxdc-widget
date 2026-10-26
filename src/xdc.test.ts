import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { parseCatalog } from "./catalog";
import { normalisePath, parseManifest, parseXdc } from "./xdc";

const zip = (files: Record<string, string | Uint8Array>) =>
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v]))) as Uint8Array<ArrayBuffer>;

describe("xdc", () => {
    it("reads name, source and icon", async () => {
        const xdc = await parseXdc(
            zip({
                "index.html": "<p>hi</p>",
                "manifest.toml": 'name = "Chess Board"\nsource_code_url = "https://codeberg.org/x/chess"\n[other]\nname = "no"',
                "icon.png": new Uint8Array([1, 2, 3]),
                "js/app.js": "1",
            }),
        );
        expect(xdc.name).toBe("Chess Board");
        expect(xdc.sourceCodeUrl).toBe("https://codeberg.org/x/chess");
        expect(xdc.icon?.type).toBe("image/png");
        expect(xdc.files.map((f) => f.path).sort()).toEqual(["icon.png", "index.html", "js/app.js", "manifest.toml"]);
        expect(xdc.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("needs index.html and a zip", async () => {
        await expect(parseXdc(zip({ "main.html": "x" }))).rejects.toThrow(/index.html/);
        await expect(parseXdc(new Uint8Array([1, 2, 3]))).rejects.toThrow(/zip/);
    });

    it("falls back to the file name and ignores unsafe source URLs", async () => {
        const xdc = await parseXdc(zip({ "index.html": "x", "manifest.toml": 'source_code_url = "javascript:alert(1)"' }), "poll");
        expect(xdc.name).toBe("poll");
        expect(xdc.sourceCodeUrl).toBeUndefined();
    });

    it("refuses path traversal", () => {
        expect(normalisePath("../evil.html")).toBeNull();
        expect(normalisePath("a/./b//c.js")).toBe("a/b/c.js");
        expect(normalisePath("\\win\\path.js")).toBe("win/path.js");
    });

    it("parses manifest strings", () => {
        expect(parseManifest(`name = "A \\"quoted\\" name" # comment\nsource_code_url='https://x'`)).toEqual({ name: 'A "quoted" name', source_code_url: "https://x" });
    });
});

describe("catalog", () => {
    it("resolves files against the catalog URL and skips broken entries", () => {
        const apps = parseCatalog(
            [
                { app_id: "b", name: "Beta", cache_relname: "b-1.xdc", icon_relname: "b.png", category: "game", size: 10 },
                { app_id: "a", name: "Alpha", cache_relname: "a-1.xdc" },
                { name: "No file" },
                { name: "Bad", cache_relname: "javascript:alert(1)" },
            ],
            "https://apps.example.org/x/xdcget-lock.json",
        );
        expect(apps.map((a) => a.name)).toEqual(["Alpha", "Beta"]);
        expect(apps[1].xdcUrl).toBe("https://apps.example.org/x/b-1.xdc");
        expect(apps[1].iconUrl).toBe("https://apps.example.org/x/b.png");
        expect(apps[0].category).toBe("other");
    });
});
