/*
 * Diagnostics for apps the smoke test flagged: start each app (APPS=id,id) and
 * log console output, failing/4xx requests, frame URLs and the overlay state.
 * RUNNER=http://127.0.0.1:4386/ points the widget at a patched runner copy.
 */
import { expect, test } from "@playwright/test";
import { host, widget } from "../real";

const ALL = "test/real/all";
const apps = (process.env.APPS ?? "").split(",").filter(Boolean);
const runner = process.env.RUNNER;
const wait = Number(process.env.WAIT ?? 6000);

test.describe.configure({ mode: "parallel" });
// The rewritten widget page (route below) would count as a public address and lose its loopback frames.
if (runner || process.env.PATCH_WIDGET || process.env.PATCH_ALLOW) test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksForIframes"] } });

for (const id of apps) {
    test(`diag ${id}`, async ({ browser }) => {
        test.setTimeout(90_000);
        const params: Record<string, string> = { matrix_user_id: "@alice:example.org", matrix_display_name: "Alice" };
        if (runner) params.runner = runner;
        const alice = await host(browser, "@alice:example.org", "Alice", { params });
        const allowMode = process.env.PATCH_ALLOW ?? "";
        const SENSORS = "accelerometer; gyroscope; magnetometer";
        if (/player|both/.test(allowMode)) {
            await alice.context().route(/localhost:4185\/assets\/index-.*\.js/, async (route) => {
                const res = await route.fetch();
                await route.fulfill({ response: res, body: (await res.text()).replace("fullscreen; autoplay; clipboard-write", `fullscreen; autoplay; clipboard-write; ${SENSORS}`) });
            });
        }
        if (/host|both/.test(allowMode)) {
            // Stands in for Element's widget iframe (AppTile) allowing the sensors.
            await alice.context().route(/localhost:4185\/__test__\/index\.html/, async (route) => {
                const res = await route.fetch();
                await route.fulfill({ response: res, body: (await res.text()).replace("document.body.appendChild(iframe);", `iframe.allow = "${SENSORS}"; document.body.appendChild(iframe);`) });
            });
        }
        if (allowMode) await alice.reload();
        if (process.env.PATCH_WIDGET) {
            // Proposed src/bridge.ts fix, applied to the built bundle in this context only:
            // the app page's load event marks the session running, with or without webxdc.js.
            await alice.context().route(/localhost:4185\/assets\/index-.*\.js/, async (route) => {
                const res = await route.fetch();
                const needle = "this.o.frame.contentWindow?.postMessage({xdc:`load`";
                const text = await res.text();
                if (!text.includes(needle)) throw new Error("bundle changed");
                const body = text.replace(needle, "this.o.frame.addEventListener(`load`,()=>{this.stopped||this.o.onStatus?.(`running`)},{once:!0})," + needle);
                await route.fulfill({ response: res, body });
            });
            await alice.reload();
        }
        if (runner) {
            // The built widget's meta CSP only frames the shared runner: let it frame the patched copy too (this context only).
            await alice.context().route(/localhost:4185\/index\.html/, async (route) => {
                const res = await route.fetch();
                const body = (await res.text()).replace("frame-src http://127.0.0.1:4186", `frame-src http://127.0.0.1:4186 ${new URL(runner).origin}`);
                await route.fulfill({ response: res, body });
            });
            await alice.reload();
        }
        const log = (s: string) => console.log(`[${id}] ${s}`);
        alice.on("console", (m) => !m.text().includes("PostmessageTransport") && log(`console.${m.type()}: ${m.text().slice(0, 400)} @${m.location().url.slice(0, 120)}`));
        alice.on("pageerror", (e) => log(`pageerror: ${e.message.slice(0, 300)}`));
        alice.context().on("response", (r) => {
            if (r.status() >= 400) log(`HTTP ${r.status()} ${r.url()} sw=${r.fromServiceWorker()} frame=${(() => { try { return r.frame().url().slice(0, 100); } catch { return "-"; } })()}`);
        });
        alice.context().on("requestfailed", (r) => log(`failed ${r.url().slice(0, 200)} ${r.failure()?.errorText}`));
        alice.on("worker", (w) => log(`worker ${w.url().slice(0, 120)}`));
        alice.on("framenavigated", (f) => log(`frame -> ${f.url().slice(0, 160)}`));

        await widget(alice).getByRole("button", { name: "Add app" }).click();
        await widget(alice).getByRole("tab", { name: "File" }).click();
        await widget(alice).locator('input[type="file"]').setInputFiles(`${ALL}/xdc/${id}.xdc`);
        await widget(alice).getByRole("button", { name: "Add to room" }).click({ timeout: 20_000 });
        const overlay = widget(alice).locator(".player-stage .overlay");
        const started = await expect(overlay).toHaveCount(0, { timeout: 20_000 }).then(() => true, () => false);
        log(`overlay gone: ${started}`);
        await alice.waitForTimeout(wait);
        for (const f of alice.frames()) {
            const info = await f
                .evaluate(() => ({ title: document.title, text: document.body?.innerText.trim().slice(0, 120), els: document.querySelectorAll("*").length, sw: navigator.serviceWorker?.controller?.scriptURL }))
                .catch((e) => String(e).slice(0, 80));
            log(`FRAME ${f.url().slice(0, 140)} ${JSON.stringify(info)}`);
        }
        log(`overlay at end: ${await overlay.count()} ${(await overlay.count()) ? await overlay.textContent() : ""}`);
        if (process.env.PROBE) {
            const f = alice.frames().find((f) => f.url().startsWith("http://127.0.0.1:4") && !f.url().includes("boot.html"));
            log(`PROBE ${await f?.evaluate(process.env.PROBE).catch((e) => "ERR " + String(e).slice(0, 200))}`);
        }
        await alice.screenshot({ path: `${process.env.SHOTS ?? "test-results"}/diag/shot-${id}${runner ? "-patched" : ""}.png` });
        await alice.context().close();
    });
}
