import { cpSync } from "node:fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

/*
 * Production CSP for the widget (the runner has its own, set by runner/sw.js).
 *
 * - frame-src: only the runner. This also stops an app from navigating its own
 *   frame to another site, which CSP inside the app cannot prevent.
 *   VITE_RUNNER_URL may contain "{key}" for one origin per instance
 *   (https://{key}.xdc.example.org/ → https://*.xdc.example.org).
 * - connect-src https: the catalog and "add from link". The room itself is
 *   reached over postMessage, which CSP does not govern.
 * - img-src https: catalog icons.
 * frame-ancestors cannot be set from <meta>; the serving nginx adds it.
 */
const runner = process.env.VITE_RUNNER_URL;
const frameSrc = runner ? new URL(runner.replace("{key}", "wildcard")).origin.replace("wildcard", "*") : "https:";

const CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "connect-src https:",
    `frame-src ${frameSrc}`,
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "manifest-src 'none'",
].join("; ");

const cspMeta = (): Plugin => ({
    name: "csp-meta",
    apply: "build", // the dev server needs ws: for HMR and inline styles
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" }],
});

/*
 * runner/ ships inside the bundle as dist/runner/, so one static deployment can
 * serve it from a second origin (on marcade.store: an own_origin alias). The
 * widget refuses a runner on its own origin, so dist/runner/ on the widget's
 * origin is inert.
 */
const copyRunner = (): Plugin => ({
    name: "copy-runner",
    apply: "build",
    closeBundle: () => cpSync("runner", "dist/runner", { recursive: true }),
});

export default defineConfig({
    // Served from a versioned path (https://…/apps/<id>/<version>/): relative URLs only.
    base: "./",
    plugins: [svelte(), cspMeta(), copyRunner()],
    build: { target: "es2022", sourcemap: false },
    server: {
        // Element and the Player frame the widget; without this Vite refuses to be embedded.
        headers: { "X-Frame-Options": "ALLOWALL" },
    },
    test: { include: ["src/**/*.test.ts"] },
});
