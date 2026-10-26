// Mimics deploy/widgets/nginx/default.conf of marcade-store: the bundle under
// /<version>/ on every host, SPA fallback, only frame-ancestors as CSP. Plus the
// mock client at /__test__/. Used to check the store layout (runner as a subpath
// of an alias origin): MARCADE_LAYOUT=1 pnpm exec playwright test widget
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT ?? 4192);
const root = new URL("../../", import.meta.url).pathname;
const version = "0.1.0";
const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
const exists = (p) => stat(p).then((s) => s.isFile()).catch(() => false);

createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    let file;
    if (path.startsWith("/__test__/")) file = join(root, "test/e2e", path.slice(9));
    else if (path.startsWith(`/${version}/`)) {
        const rel = path.slice(version.length + 2) || "index.html";
        file = join(root, "dist", rel.endsWith("/") ? `${rel}index.html` : rel);
        if (!(await exists(file))) file = join(root, "dist/index.html"); // SPA fallback, as nginx
    } else return res.writeHead(404).end();
    if (!(await exists(file))) return res.writeHead(404).end();
    const headers = { "Content-Type": types[extname(file)] ?? "application/octet-stream" };
    // The widgets nginx header; not on the mock client, which plays Element's top-level page.
    if (!path.startsWith("/__test__/")) headers["Content-Security-Policy"] = "frame-ancestors *";
    res.writeHead(200, headers);
    res.end(await readFile(file));
}).listen(port, () => console.log(`marcade-like server on :${port}`));
