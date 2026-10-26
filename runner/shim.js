/*
 * window.webxdc for apps run by the webxdc player widget.
 *
 * sw.js prepends `self.__WEBXDC_META__ = {…}` (the values apps read
 * synchronously) and serves the result as <app>/webxdc.js. Everything else
 * goes to the widget over a MessagePort it hands over after a hello. The
 * widget owns the room: it turns updates into Matrix events and back.
 *
 * Spec: https://webxdc.org/docs/spec/
 */
(function () {
    "use strict";

    // A page the app frames itself (rare) shares its parent's API.
    try {
        if (window.parent !== window && window.parent.webxdc && window.parent.location.origin === location.origin) {
            window.webxdc = window.parent.webxdc;
            return;
        }
    } catch {
        /* the parent is the widget: cross-origin, as intended */
    }

    const meta = self.__WEBXDC_META__ || {};
    delete self.__WEBXDC_META__;
    const parentOrigin = meta.parentOrigin;

    // ---- Port to the widget ------------------------------------------------

    let port = null;
    const outbox = [];
    const pending = new Map();
    let nextId = 1;

    function post(message, transfer) {
        if (port) port.postMessage(message, transfer || []);
        else outbox.push([message, transfer]);
    }

    function request(message, transfer) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            post({ ...message, id }, transfer);
        });
    }

    addEventListener("message", (e) => {
        if (e.source !== window.parent || e.origin !== parentOrigin || !e.data || e.data.xdc !== "port" || port) return;
        port = e.ports[0];
        port.onmessage = (m) => onWidgetMessage(m.data);
        for (const [message, transfer] of outbox.splice(0)) port.postMessage(message, transfer || []);
    });
    window.parent.postMessage({ xdc: "hello", key: meta.key }, parentOrigin);

    // ---- Updates -----------------------------------------------------------

    let listener = null;
    let listenDone = null;
    let realtime = null;

    function onWidgetMessage(m) {
        if (!m || typeof m.t !== "string") return;
        switch (m.t) {
            case "update":
                if (listener) {
                    try {
                        listener(m.update);
                    } catch (err) {
                        console.error("webxdc update listener failed", err);
                    }
                }
                break;
            case "listen-done":
                if (listenDone) listenDone();
                listenDone = null;
                break;
            case "reply": {
                const p = pending.get(m.id);
                if (!p) break;
                pending.delete(m.id);
                if (m.error) p.reject(new Error(m.error));
                else p.resolve(m.value);
                break;
            }
            case "rt-data":
                if (!realtime) break;
                // Before setListener (the app joined a moment ago): kept for it, not lost.
                if (!realtime.listener) {
                    if (realtime.early.length < 256) realtime.early.push(new Uint8Array(m.data));
                    break;
                }
                try {
                    realtime.listener(new Uint8Array(m.data));
                } catch (err) {
                    console.error("webxdc realtime listener failed", err);
                }
                break;
        }
    }

    function isPlainJson(value) {
        try {
            return JSON.stringify(value) !== undefined;
        } catch {
            return false;
        }
    }

    const webxdc = {
        selfAddr: meta.selfAddr || "",
        selfName: meta.selfName || "",
        isAppSender: !!meta.isAppSender,
        isBroadcast: !!meta.isBroadcast,
        sendUpdateInterval: meta.sendUpdateInterval || 10000,
        sendUpdateMaxSize: meta.sendUpdateMaxSize || 128000,

        sendUpdate(update, _descr) {
            if (!update || update.payload === undefined) throw new Error("sendUpdate: update.payload must not be undefined");
            if (!isPlainJson(update.payload)) throw new Error("sendUpdate: payload must be JSON-serializable");
            // JSON round trip: drops what JSON drops, exactly as other messengers do.
            const json = JSON.stringify(update);
            const size = new TextEncoder().encode(json).length;
            if (size > webxdc.sendUpdateMaxSize) throw new Error(`sendUpdate: update is ${size} bytes, more than sendUpdateMaxSize (${webxdc.sendUpdateMaxSize})`);
            post({ t: "send", update: JSON.parse(json) });
        },

        setUpdateListener(cb, serial) {
            listener = typeof cb === "function" ? cb : null;
            return new Promise((resolve) => {
                listenDone = resolve;
                post({ t: "listen", serial: Number(serial) || 0 });
            });
        },

        /** Deprecated in the spec, still used by older apps. */
        getAllUpdates() {
            return request({ t: "all" });
        },

        sendToChat(message) {
            if (!message || (!message.file && typeof message.text !== "string")) {
                return Promise.reject(new Error("sendToChat: set file, text or both"));
            }
            const out = {};
            if (typeof message.text === "string") out.text = message.text;
            if (message.file) {
                const f = message.file;
                if (!f.name) return Promise.reject(new Error("sendToChat: file.name is missing"));
                let blob;
                if (f.blob instanceof Blob) blob = f.blob;
                else if (typeof f.base64 === "string") {
                    const bin = atob(f.base64);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    blob = new Blob([bytes]);
                } else if (typeof f.plainText === "string") blob = new Blob([f.plainText], { type: "text/plain" });
                else return Promise.reject(new Error("sendToChat: file needs blob, base64 or plainText"));
                out.file = { name: String(f.name), blob, type: f.type || blob.type || "" };
            }
            return request({ t: "toChat", message: out });
        },

        importFiles(filter) {
            filter = filter || {};
            return new Promise((resolve, reject) => {
                const input = document.createElement("input");
                input.type = "file";
                input.style.display = "none";
                const accept = [...(filter.extensions || []), ...(filter.mimeTypes || [])];
                if (accept.length) input.accept = accept.join(",");
                input.multiple = !!filter.multiple;
                input.addEventListener("change", () => {
                    resolve(Array.from(input.files || []));
                    input.remove();
                });
                input.addEventListener("cancel", () => {
                    resolve([]);
                    input.remove();
                });
                document.body.appendChild(input);
                try {
                    input.click();
                } catch (err) {
                    input.remove();
                    reject(err);
                }
            });
        },
    };

    if (meta.realtime) {
        webxdc.joinRealtimeChannel = function () {
            if (realtime) throw new Error("joinRealtimeChannel: already joined; call leave() first");
            post({ t: "rt-join" });
            const channel = {
                listener: null,
                early: [],
                setListener(cb) {
                    channel.listener = typeof cb === "function" ? cb : null;
                    const early = channel.listener ? channel.early.splice(0) : [];
                    for (const data of early) {
                        try {
                            channel.listener(data);
                        } catch (err) {
                            console.error("webxdc realtime listener failed", err);
                        }
                    }
                },
                send(data) {
                    if (realtime !== channel) throw new Error("realtime channel was left");
                    if (!(data instanceof Uint8Array)) throw new Error("send: data must be a Uint8Array");
                    if (data.byteLength > 128000) throw new Error("send: data exceeds 128000 bytes");
                    post({ t: "rt-send", data: data.slice().buffer });
                },
                leave() {
                    if (realtime !== channel) return;
                    realtime = null;
                    post({ t: "rt-leave" });
                },
            };
            realtime = channel;
            return channel;
        };
    }

    Object.defineProperty(window, "webxdc", { value: Object.freeze(webxdc), configurable: false, writable: false });

    // ---- Links: the widget shows the full URL and asks first --------------

    function external(href) {
        try {
            const url = new URL(href, location.href);
            return url.origin === location.origin && url.protocol !== "mailto:" && url.protocol !== "tel:" ? null : url;
        } catch {
            return null;
        }
    }

    document.addEventListener(
        "click",
        (e) => {
            const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
            if (!a) return;
            const url = external(a.getAttribute("href"));
            if (!url) return;
            e.preventDefault();
            post({ t: "link", url: url.href });
        },
        true,
    );

    window.open = function (href) {
        const url = external(String(href || ""));
        if (url) post({ t: "link", url: url.href });
        return null;
    };

    // ---- Best-effort network denial beyond CSP ----------------------------

    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
        try {
            // Writable: apps (quake3) put their own fakes over joinRealtimeChannel
            // here, and a strict-mode assignment to a read-only property throws.
            // The guard sw.js puts into every page does the real work.
            Object.defineProperty(window, name, { value: undefined, configurable: true, writable: true });
        } catch {
            /* already locked */
        }
    }

    // ---- Storage per instance on a shared runner origin --------------------
    // Functional isolation only: two copies of an app (or two apps) keep apart.
    // A hostile app can still reach the raw storage; real isolation needs one
    // runner origin per instance.

    if (meta.isolateStorage) {
        const prefix = `xdc:${meta.key}:`;

        const wrapStorage = (store) => {
            const ownKeys = () => {
                const out = [];
                for (let i = 0; i < store.length; i++) {
                    const k = store.key(i);
                    if (k !== null && k.startsWith(prefix)) out.push(k.slice(prefix.length));
                }
                return out;
            };
            const api = {
                getItem: (k) => store.getItem(prefix + k),
                setItem: (k, v) => store.setItem(prefix + k, String(v)),
                removeItem: (k) => store.removeItem(prefix + k),
                clear: () => ownKeys().forEach((k) => store.removeItem(prefix + k)),
                key: (i) => ownKeys()[i] ?? null,
            };
            return new Proxy(api, {
                get(target, k) {
                    if (k === "length") return ownKeys().length;
                    if (k in target) return target[k];
                    if (typeof k !== "string") return undefined;
                    const v = store.getItem(prefix + k);
                    return v === null ? undefined : v;
                },
                set(_t, k, v) {
                    store.setItem(prefix + String(k), String(v));
                    return true;
                },
                deleteProperty(_t, k) {
                    store.removeItem(prefix + String(k));
                    return true;
                },
                has(target, k) {
                    return k in target || store.getItem(prefix + String(k)) !== null;
                },
                ownKeys: () => ownKeys(),
                getOwnPropertyDescriptor(_t, k) {
                    const v = store.getItem(prefix + String(k));
                    return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true };
                },
            });
        };

        for (const name of ["localStorage", "sessionStorage"]) {
            try {
                const wrapped = wrapStorage(window[name]);
                Object.defineProperty(window, name, { get: () => wrapped, configurable: true });
            } catch {
                /* storage unavailable: the app sees the browser's own error */
            }
        }

        try {
            const idb = window.indexedDB;
            const open = idb.open.bind(idb);
            const del = idb.deleteDatabase.bind(idb);
            const list = idb.databases ? idb.databases.bind(idb) : null;
            // IDBDatabase.name would show the prefix; apps that reuse db.name as a store name break (ZenFS).
            const nameOf = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "name");
            Object.defineProperty(IDBDatabase.prototype, "name", {
                ...nameOf,
                get() {
                    const n = nameOf.get.call(this);
                    return n.startsWith(prefix) ? n.slice(prefix.length) : n;
                },
            });
            idb.open = (name, version) => (version === undefined ? open(prefix + name) : open(prefix + name, version));
            idb.deleteDatabase = (name) => del(prefix + name);
            if (list) {
                idb.databases = () =>
                    list().then((dbs) => dbs.filter((d) => d.name.startsWith(prefix)).map((d) => ({ ...d, name: d.name.slice(prefix.length) })));
            }
        } catch {
            /* no IndexedDB */
        }

        try {
            const cs = window.caches;
            const open = cs.open.bind(cs);
            const has = cs.has.bind(cs);
            const del = cs.delete.bind(cs);
            const keys = cs.keys.bind(cs);
            cs.open = (n) => open(prefix + n);
            cs.has = (n) => has(prefix + n);
            cs.delete = (n) => del(prefix + n);
            cs.keys = () => keys().then((ns) => ns.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length)));
            cs.match = async (req, opts) => {
                for (const n of await cs.keys()) {
                    const hit = await (await open(prefix + n)).match(req, opts);
                    if (hit) return hit;
                }
                return undefined;
            };
        } catch {
            /* no Cache API */
        }
    }
})();
