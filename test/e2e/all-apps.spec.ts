/*
 * Smoke test of every app in the webxdc.org catalog: add the .xdc to the room
 * through the File tab, start it, let it settle, record what happened. Needs
 * `node scripts/fetch-catalog.mjs` first; run with ALL_APPS=1, APPS=id,id to
 * pick some. Writes test/real/all/results/<id>.json and shots/<id>.png; a test
 * fails only when the app does not start at all, the rest is in the JSON.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Frame } from "@playwright/test";
import { host, NS, widget, type W } from "./real";

const ALL = "test/real/all";
const catalog: { app_id: string; name: string; category?: string }[] = existsSync(`${ALL}/catalog.json`) ? JSON.parse(readFileSync(`${ALL}/catalog.json`, "utf8")) : [];
const pick = process.env.APPS?.split(",").filter(Boolean);
const apps = catalog.filter((a) => !pick || pick.includes(a.app_id));

test.skip(!process.env.ALL_APPS, "ALL_APPS=1, after node scripts/fetch-catalog.mjs");
test.describe.configure({ mode: "parallel" });
mkdirSync(`${ALL}/results`, { recursive: true });
mkdirSync(`${ALL}/shots`, { recursive: true });

for (const meta of apps) {
    test(meta.app_id, async ({ browser }) => {
        test.setTimeout(60_000);
        const alice = await host(browser, "@alice:example.org", "Alice");
        const errors: string[] = [];
        const blocked: string[] = [];
        const external: string[] = [];
        alice.on("pageerror", (e) => errors.push(e.message.slice(0, 300)));
        alice.on("console", (m) => {
            const text = m.text().slice(0, 300);
            if (/Content.Security.Policy|Refused to/i.test(text)) blocked.push(text);
            else if (m.type() === "error") errors.push(text);
        });
        // What the app itself reaches for outside its runner origin (the CSP blocks it).
        alice.on("request", (r) => {
            let inApp = false;
            try {
                inApp = /\/app\/[^/]+\//.test(r.frame().url());
            } catch {
                /* service worker request: no frame */
            }
            if (inApp && /^https?:/.test(r.url()) && new URL(r.url()).origin !== new URL(r.frame().url()).origin) external.push(r.url().slice(0, 200));
        });

        const result: Record<string, unknown> = { id: meta.app_id, name: meta.name, category: meta.category };
        const save = () => writeFileSync(`${ALL}/results/${meta.app_id}.json`, JSON.stringify({ ...result, errors, blocked, external }, null, 1));
        try {
            await widget(alice).getByRole("button", { name: "Add app" }).click();
            await widget(alice).getByRole("tab", { name: "File" }).click();
            await widget(alice).locator('input[type="file"]').setInputFiles(`${ALL}/xdc/${meta.app_id}.xdc`);
            const added = widget(alice).getByRole("button", { name: "Add to room" });
            const refused = widget(alice).getByRole("alert");
            await expect(added.or(refused)).toBeVisible({ timeout: 20_000 });
            if (await refused.isVisible()) throw new Error(`not accepted: ${await refused.textContent()}`);
            await added.click();

            // The Player renders with its overlay up; checking before that would pass too early.
            await expect(widget(alice).locator(".player-stage")).toBeVisible({ timeout: 20_000 });
            const overlay = widget(alice).locator(".player-stage .overlay");
            await expect(overlay).toHaveCount(0, { timeout: 30_000 }).catch(async () => {
                throw new Error(`did not start: ${(await overlay.textContent())?.trim().slice(0, 200)}`);
            });
            result.started = true;
            await alice.waitForTimeout(4000);

            let frame: Frame | undefined;
            // The app frame is the widget frame's child; some apps rewrite their URL (history.replaceState).
            await expect.poll(() => (frame = alice.frames().find((f) => f.parentFrame()?.parentFrame() === alice.mainFrame()))).toBeTruthy();
            Object.assign(
                result,
                await frame!.evaluate(() => ({
                    page: location.pathname.replace(/^.*\/app\/[^/]+/, ""),
                    rtc: typeof (window as W).RTCPeerConnection,
                    title: document.title,
                    text: document.body?.innerText.trim().length ?? 0,
                    elements: document.body?.querySelectorAll("*").length ?? 0,
                    canvases: document.querySelectorAll("canvas").length,
                    height: document.documentElement.scrollHeight,
                })),
            );
            const sent = await alice.evaluate(() => (window as W).__SENT__);
            result.updates = sent.filter((s: any) => s.type === `${NS}.update`).length;
            result.blank = !result.text && !result.canvases && (result.elements as number) < 3;
        } catch (err) {
            result.started ??= false;
            result.failure = err instanceof Error ? err.message.split("\n")[0].slice(0, 300) : String(err);
        } finally {
            await alice.screenshot({ path: `${ALL}/shots/${meta.app_id}.png` }).catch(() => {});
            save();
            await alice.context().close();
        }
        expect(result.failure, String(result.failure)).toBeUndefined();
    });
}
