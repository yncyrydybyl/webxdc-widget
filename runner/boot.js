/*
 * Runner bootstrap. The player widget frames this page on the runner origin
 * (never the widget's own origin) with #parent=<widget origin>&key=<instance key>.
 *
 * 1. Register sw.js, which serves /app/<key>/… from Cache Storage.
 * 2. Tell the widget it is ready.
 * 3. Receive the files and the per-user values webxdc.js needs
 *    synchronously (selfAddr, selfName, …), store them, and navigate to the app.
 *
 * Everything after step 3 happens in the app's own document, through webxdc.js
 * (shim.js) and a MessagePort the widget hands over.
 */
(function () {
    "use strict";

    const status = document.getElementById("status");
    const fail = (message) => {
        status.textContent = message;
        status.className = "error";
        try {
            parent.postMessage({ xdc: "boot-error", message }, parentOrigin || "*");
        } catch {
            /* nothing else to do */
        }
    };

    const params = new URLSearchParams(location.hash.slice(1));
    const parentOrigin = params.get("parent");
    const key = params.get("key");
    const href = params.get("href") || "";

    if (!parentOrigin || !key || !/^[0-9a-f]{16,64}$/.test(key)) {
        fail("This page runs webxdc apps for the webxdc player widget. Open an app from the widget.");
        return;
    }
    if (parentOrigin === location.origin) {
        // A widget on the runner's own origin could be scripted by every app it runs.
        fail("The player widget and the runner must be on different origins.");
        return;
    }
    if (window.parent === window) {
        fail("This page only works inside the webxdc player widget.");
        return;
    }
    if (!("serviceWorker" in navigator) || !("caches" in window)) {
        fail("This browser does not allow service workers here (private mode or blocked third-party storage), so apps cannot run.");
        return;
    }

    const scope = new URL("./", location.href).href;
    const appBase = `${scope}app/${key}/`;
    const cacheName = `xdc-${key}`;

    async function start() {
        await navigator.serviceWorker.register("sw.js", { scope: "./" });
        await navigator.serviceWorker.ready;
        parent.postMessage({ xdc: "boot", key }, parentOrigin);
    }

    /*
     * The files always come from the widget, which checked them against the hash
     * in the room. Whatever the cache held is discarded first: anything framed in
     * the same client could have framed this page and filled it.
     */
    async function load(data) {
        if (!Array.isArray(data.files)) throw new Error("no files");
        status.textContent = "Unpacking…";
        await caches.delete(cacheName);
        const cache = await caches.open(cacheName);
        for (const [path, bytes] of data.files) {
            await cache.put(new Request(appBase + encodePath(path)), new Response(bytes));
        }
        // Read by sw.js when it builds webxdc.js for this app.
        await cache.put(
            new Request(`${appBase}__webxdc_meta__`),
            new Response(JSON.stringify({ ...data.meta, key, parentOrigin }), { headers: { "Content-Type": "application/json" } }),
        );
        const target = new URL(href.replace(/^\/+/, "") || "index.html", appBase);
        if (!target.href.startsWith(appBase)) target.href = `${appBase}index.html`;
        location.replace(target.href);
    }

    /** Matches how sw.js looks files up: each segment percent-encoded. */
    function encodePath(path) {
        return path.split("/").map(encodeURIComponent).join("/");
    }

    addEventListener("message", (e) => {
        if (e.source !== parent || e.origin !== parentOrigin || !e.data) return;
        if (e.data.xdc === "load" && e.data.key === key) {
            load(e.data).catch((err) => fail(`Could not start the app: ${err && err.message ? err.message : err}`));
        }
    });

    start().catch((err) => fail(`Could not start the runner: ${err && err.message ? err.message : err}`));
})();
