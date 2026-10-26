/*
 * Put first into every app page by sw.js. WebRTC reaches any STUN server whatever
 * the CSP says, and tells it the user's IP address; this runs before the page's own scripts and removes it from the
 * page and from every same-origin frame the page makes (about:blank, srcdoc, its
 * own files: those get the guard served too). A sandboxed frame without
 * allow-same-origin would be out of reach, so such frames get allow-same-origin:
 * they hold the app's own code, which has that access anyway.
 */
"use strict";

(function () {
    const names = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCSctpTransport"];
    const scrub = (w) => {
        try {
            for (const n of names) if (w && w[n]) Object.defineProperty(w, n, { value: undefined, writable: true, configurable: true });
        } catch {
            /* cross-origin: not ours to reach, and not served by us */
        }
    };
    const sweep = () => {
        for (let i = 0; i < window.length; i++) scrub(window[i]);
    };
    scrub(window);

    // Apps are written for an origin of their own and start workers or frames from
    // root paths ("/assets/encoder.js", "/index.html"). Here such a URL lies outside
    // the service worker's scope (the runner lives under /<version>/runner/), so the
    // worker's own imports, or the frame's page, would never reach it. Into the app.
    const appPath = (/^(.*\/app\/[0-9a-f]{16,64}\/)/.exec(location.pathname) || [])[1];
    const intoApp = (u) => {
        if (!appPath || (typeof u !== "string" && !(u instanceof URL))) return u;
        try {
            const url = new URL(String(u), location.href);
            if (url.origin !== location.origin || url.pathname.startsWith(appPath)) return u;
            return appPath + url.pathname.slice(1) + url.search + url.hash;
        } catch {
            return u;
        }
    };
    for (const name of ["Worker", "SharedWorker"]) {
        const Native = window[name];
        if (typeof Native !== "function") continue;
        window[name] = new Proxy(Native, { construct: (target, [url, ...rest]) => Reflect.construct(target, [intoApp(url), ...rest]) });
    }
    const srcd = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
    if (srcd && srcd.set)
        Object.defineProperty(HTMLIFrameElement.prototype, "src", {
            ...srcd,
            set(v) {
                srcd.set.call(this, intoApp(v));
            },
        });
    const fix = (el) => {
        const sb = el.getAttribute && el.getAttribute("sandbox");
        if (sb !== null && sb !== undefined && /allow-scripts/.test(sb) && !/allow-same-origin/.test(sb)) el.setAttribute("sandbox", `${sb} allow-same-origin`);
    };
    const getters = [
        [HTMLIFrameElement.prototype, "contentWindow", (v) => v],
        [HTMLIFrameElement.prototype, "contentDocument", (v) => v && v.defaultView],
        [HTMLFrameElement.prototype, "contentWindow", (v) => v],
        [HTMLObjectElement.prototype, "contentWindow", (v) => v],
    ];
    for (const [proto, prop, win] of getters) {
        const d = Object.getOwnPropertyDescriptor(proto, prop);
        if (d && d.get)
            Object.defineProperty(proto, prop, {
                ...d,
                get() {
                    const v = d.get.call(this);
                    scrub(win(v));
                    return v;
                },
            });
    }
    const after = (proto, name) => {
        const orig = proto[name];
        if (typeof orig !== "function") return;
        proto[name] = function (...args) {
            for (const a of args) if (a && a.nodeType === 1) [a, ...a.querySelectorAll("iframe,frame")].forEach(fix);
            const r = orig.apply(this, args);
            sweep();
            return r;
        };
    };
    for (const n of ["appendChild", "insertBefore", "replaceChild"]) after(Node.prototype, n);
    for (const n of ["append", "prepend", "after", "before", "replaceWith", "insertAdjacentElement", "insertAdjacentHTML"]) after(Element.prototype, n);
    after(Document.prototype, "write");
    after(Document.prototype, "writeln");
    for (const prop of ["innerHTML", "outerHTML"]) {
        const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
        Object.defineProperty(Element.prototype, prop, {
            ...d,
            set(v) {
                d.set.call(this, v);
                document.querySelectorAll("iframe,frame").forEach(fix);
                sweep();
            },
        });
    }
    const setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        const n = String(name).toLowerCase();
        setAttr.call(this, name, n === "src" && this instanceof HTMLIFrameElement ? intoApp(value) : value);
        if (n === "sandbox") fix(this);
    };
    const sbd = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "sandbox");
    if (sbd && sbd.get)
        Object.defineProperty(HTMLIFrameElement.prototype, "sandbox", {
            ...sbd,
            get() {
                const list = sbd.get.call(this);
                const add = list.add.bind(list);
                list.add = (...t) => (add(...t), fix(this));
                return list;
            },
        });
    new MutationObserver(() => {
        document.querySelectorAll("iframe,frame").forEach(fix);
        sweep();
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["sandbox"] });
})();
