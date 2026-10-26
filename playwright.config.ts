import { defineConfig, devices } from "@playwright/test";

// Widget on localhost, runner on 127.0.0.1: two sites, so the runner is a
// third-party frame with a partitioned service worker, as under Element.
// WebKit is left out: Playwright's WebKit does not run on Fedora hosts.
// MARCADE_LAYOUT=1: the store's layout instead (bundle under /0.1.0/, runner at
// /0.1.0/runner/ of a second host), built with
// VITE_RUNNER_URL=http://127.0.0.1:4192/0.1.0/runner/.
const marcade = !!process.env.MARCADE_LAYOUT;

export default defineConfig({
    testDir: "./test/e2e",
    testMatch: "**/*.spec.ts",
    // One test per catalog app: only on request (ALL_APPS=1, after scripts/fetch-catalog.mjs).
    testIgnore: process.env.ALL_APPS ? [] : ["**/apps/**"],
    timeout: 45_000,
    use: { baseURL: marcade ? "http://localhost:4192" : "http://localhost:4185" },
    projects: [
        { name: "chromium", use: { ...devices["Desktop Chrome"] } },
        {
            name: "firefox",
            use: {
                ...devices["Desktop Firefox"],
                // CI runs in a Kubernetes pod with a 64 MB /dev/shm, where Firefox's
                // content processes crash on start ("Target crashed"). Fewer of them
                // fit: one content process and no per-site isolation.
                ...(process.env.CI ? { launchOptions: { firefoxUserPrefs: { "fission.autostart": false, "dom.ipc.processCount": 1 } } } : {}),
            },
        },
    ],
    webServer: marcade
        ? [{ command: "node test/e2e/marcade-like-server.mjs", url: "http://localhost:4192/0.1.0/index.html", reuseExistingServer: true, timeout: 20_000 }]
        : [
        { command: "node test/e2e/server.mjs", url: "http://localhost:4185/index.html", reuseExistingServer: true, timeout: 20_000 },
        { command: "node scripts/runner-server.mjs 4186", url: "http://127.0.0.1:4186/boot.html", reuseExistingServer: true, timeout: 20_000 },
    ],
});
