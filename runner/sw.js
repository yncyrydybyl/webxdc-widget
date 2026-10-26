/*
 * Serves webxdc apps from Cache Storage. boot.js puts each app's files at
 * <scope>app/<key>/<path>; this worker answers every request under app/ from
 * there and nothing else, and attaches the CSP that keeps the app offline.
 *
 * webxdc.js is not part of an .xdc file (the spec forbids shipping it): it is
 * built here from shim.js plus the instance's values that apps read
 * synchronously at load (selfAddr, selfName, isAppSender, limits).
 */
"use strict";

const VERSION = "7";
const STATIC = `runner-static-${VERSION}`;
const SCOPE = self.registration.scope;
const APP_PREFIX = `${SCOPE}app/`;

/*
 * 'self' is the runner origin, which serves nothing but the cached app. Inline
 * code and eval stay allowed because many existing apps rely on them; what
 * matters is that nothing can be loaded from, or sent to, anywhere else.
 * CSP cannot block WebRTC yet (the `webrtc` directive is not shipped): guard.js
 * runs first in every page and removes it. Frames from data: and blob:
 * would start with a fresh, unguarded window, so frames come from 'self' only.
 */
const CSP = [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
    "style-src 'self' 'unsafe-inline' data: blob:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' data: blob:",
    "frame-src 'self'",
    "child-src 'self' blob:",
    "manifest-src 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "base-uri 'self'",
].join("; ");

const TYPES = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json",
    map: "application/json",
    txt: "text/plain; charset=utf-8",
    md: "text/plain; charset=utf-8",
    toml: "text/plain; charset=utf-8",
    xml: "application/xml",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    bmp: "image/bmp",
    wasm: "application/wasm",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    pdf: "application/pdf",
    csv: "text/csv; charset=utf-8",
    ics: "text/calendar; charset=utf-8",
};

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(STATIC)
            .then((c) => c.addAll(["shim.js", "guard.js"]))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) => Promise.all(names.filter((n) => n.startsWith("runner-static-") && n !== STATIC).map((n) => caches.delete(n))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return; // CSP already blocks these
    if (url.href.startsWith(APP_PREFIX) && keyOf(url.href)) return event.respondWith(serve(event, url));
    // Apps are written for Delta Chat, which serves each one at an origin root, so
    // many ask for "/assets/x.js". Map such paths into the app that asked.
    event.respondWith(fromRoot(event, url));
});

/** The app key of a page URL under app/, or null. */
function keyOf(href) {
    if (!href || !href.startsWith(APP_PREFIX)) return null;
    const key = href.slice(APP_PREFIX.length).split("/")[0];
    return /^[0-9a-f]{16,64}$/.test(key) ? key : null;
}

async function fromRoot(event, url) {
    let key = null;
    if (event.clientId) {
        const client = await self.clients.get(event.clientId);
        key = client ? keyOf(client.url) : null;
        // A worker started from a blob: URL (Emscripten, Babylon, …) or from a root
        // path ("/assets/encoder.js") has no app path to tell its app by; it belongs
        // to the only app open here.
        if (!key && client && isOrphanWorker(client)) key = await soleAppKey();
    } else if (event.request.mode === "navigate") {
        // A link to "/other.html": navigations have no client yet, but app pages
        // send a same-origin referrer (Referrer-Policy below).
        key = keyOf(event.request.referrer);
    }
    if (!key) return fetch(event.request);
    // "../img/x.png" from the app's root climbs into app/ here; at an origin root
    // it would have stopped at "/". Treat both the same.
    let path = url.pathname;
    const appPath = new URL(APP_PREFIX).pathname;
    if (path.startsWith(appPath)) path = path.slice(appPath.length - 1);
    const mapped = new URL(`${APP_PREFIX}${key}${path}${url.search}`);
    // A page must live under app/<key>/ or its own relative and root loads lose their app.
    if (event.request.mode === "navigate") return Response.redirect(mapped.href, 302);
    return serve(event, mapped);
}

async function serve(event, url) {
    const rest = url.pathname.slice(new URL(APP_PREFIX).pathname.length);
    const slash = rest.indexOf("/");
    const key = slash === -1 ? rest : rest.slice(0, slash);
    let path = slash === -1 ? "" : rest.slice(slash + 1);
    if (!/^[0-9a-f]{16,64}$/.test(key)) return notFound();

    // An app may read its own files, not another app's.
    if (event.clientId && !(await clientMayRead(event.clientId, key))) return notFound();

    if (path === "" || path.endsWith("/")) path += "index.html";
    // boot.js stores each segment encodeURIComponent-ed; browsers leave some characters (@, :) bare.
    path = path
        .split("/")
        .map((s) => {
            try {
                return encodeURIComponent(decodeURIComponent(s));
            } catch {
                return s;
            }
        })
        .join("/");
    if (path === "__webxdc_meta__") return notFound();

    const cache = await caches.open(`xdc-${key}`);
    const appBase = `${APP_PREFIX}${key}/`;

    if (path === "webxdc.js") {
        const meta = await cache.match(`${appBase}__webxdc_meta__`);
        const shim = await (await caches.open(STATIC)).match("shim.js");
        if (!meta || !shim) return notFound();
        const body = `self.__WEBXDC_META__ = ${await meta.text()};\n${await shim.text()}`;
        return respond(body, "js");
    }

    const hit = await cache.match(appBase + path);
    if (!hit) return notFound();
    const ext = (path.split(".").pop() || "").toLowerCase();
    if (ext === "html" || ext === "htm") return respond(await guarded(new Uint8Array(await hit.arrayBuffer()), new URL(appBase).pathname), ext);
    return respond(hit.body, ext);
}

/** The page with guard.js as its first script; frames from root paths into the app, sandboxed ones with allow-same-origin. Works on bytes: the page may be in any charset. */
async function guarded(bytes, appPath) {
    const guard = await (await caches.open(STATIC)).match("guard.js");
    if (!guard) throw new Error("guard.js missing from the runner cache");
    const GUARD = `<script>${await guard.text()}</script>`;
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    // Frames in the page itself: a root path into the app, as guard() does for scripted ones.
    s = s.replace(/(<iframe\b[^>]*\bsrc\s*=\s*)(["'])\/(?!\/)/gi, (m, pre, q) => `${pre}${q}${appPath}`);
    s = s.replace(/(<iframe\b[^>]*\bsandbox\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, v) =>
        /allow-scripts/i.test(v) && !/allow-same-origin/i.test(v) ? `${pre}${q}${v} allow-same-origin${q}` : m,
    );
    const at = [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i].map((re) => re.exec(s)).find(Boolean);
    const pos = at ? at.index + at[0].length : 0;
    s = s.slice(0, pos) + GUARD + s.slice(pos);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

async function clientMayRead(clientId, key) {
    const client = await self.clients.get(clientId);
    if (!client) return true;
    if (client.url.startsWith(`${APP_PREFIX}${key}/`)) return true;
    if (isOrphanWorker(client)) return (await soleAppKey()) === key;
    // Pages outside app/ (boot.html) load nothing from here.
    return !client.url.startsWith(APP_PREFIX);
}

/** A worker outside app/<key>/ (blob: or a root path). Pages there (boot.html) are not workers. */
function isOrphanWorker(client) {
    return client.url.startsWith("blob:") || ((client.type === "worker" || client.type === "sharedworker") && !keyOf(client.url));
}

/** The key of the app open in this browser partition, or null when there is none or more than one. */
async function soleAppKey() {
    const keys = new Set((await self.clients.matchAll({ type: "window" })).map((c) => keyOf(c.url)).filter(Boolean));
    return keys.size === 1 ? [...keys][0] : null;
}

function respond(body, ext) {
    return new Response(body, {
        status: 200,
        headers: {
            "Content-Type": TYPES[ext] || "application/octet-stream",
            "Content-Security-Policy": CSP,
            // Same-origin only (nothing else is reachable anyway): lets fromRoot() map navigations.
            "Referrer-Policy": "same-origin",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
        },
    });
}

function notFound() {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain", "Content-Security-Policy": CSP } });
}
