/*
 * Serves runner/ on its own origin, with the headers production nginx should
 * send. Development and tests only.
 *   node scripts/runner-server.mjs [port] [host]
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.argv[2] ?? process.env.RUNNER_PORT ?? 5174);
const host = process.argv[3] ?? "127.0.0.1";
const root = new URL("../runner/", import.meta.url).pathname;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    let path = normalize(decodeURIComponent(url.pathname));
    if (path.includes("..")) return res.writeHead(400).end();
    if (path === "/") path = "/boot.html";
    try {
        const body = await readFile(join(root, path));
        res.writeHead(200, {
            "Content-Type": types[extname(path)] ?? "application/octet-stream",
            "Cache-Control": "no-cache",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            // boot.html: own code only. App pages get their CSP from sw.js.
            "Content-Security-Policy": "default-src 'self'; frame-ancestors *; object-src 'none'; base-uri 'none'",
            "Service-Worker-Allowed": "/",
        });
        res.end(body);
    } catch {
        // /app/… without the service worker (first load, hard reload): nothing to serve.
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    }
}).listen(port, host, () => console.log(`webxdc runner on http://${host}:${port}/`));
