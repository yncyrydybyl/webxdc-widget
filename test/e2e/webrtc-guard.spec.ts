/*
 * The webxdc-test app (webxdc.org catalog) probes WebRTC every way it knows:
 * top window, same-origin iframes, sandboxed iframes, a fresh about:blank
 * iframe. None of them may reach a STUN server. Needs
 * `node scripts/fetch-catalog.mjs`; run with ALL_APPS=1.
 */
import { existsSync } from "node:fs";
import { expect, test, type Frame } from "@playwright/test";
import { app, host, widget } from "./real";

const XDC = "test/real/all/xdc/webxdc-test.xdc";
test.skip(!process.env.ALL_APPS || !existsSync(XDC), "ALL_APPS=1, after node scripts/fetch-catalog.mjs");

test("no WebRTC way out of the runner", async ({ browser }) => {
    test.setTimeout(90_000);
    const alice = await host(browser, "@alice:example.org", "Alice");
    await widget(alice).getByRole("button", { name: "Add app" }).click();
    await widget(alice).getByRole("tab", { name: "File" }).click();
    await widget(alice).locator('input[type="file"]').setInputFiles(XDC);
    await widget(alice).getByRole("button", { name: "Add to room" }).click();
    await expect(widget(alice).locator(".player-stage")).toBeVisible();
    await expect(widget(alice).locator(".player-stage .overlay")).toHaveCount(0, { timeout: 30_000 });
    await app(alice).locator("#tab-sandbox").click();

    let frame: Frame | undefined;
    await expect.poll(() => (frame = alice.frames().find((f) => f.parentFrame()?.parentFrame() === alice.mainFrame()))).toBeTruthy();
    // The app and every frame inside it report GOOD/BAD per probe; STUN probes take a few seconds.
    const inApp = (f: Frame): boolean => f === frame || (!!f.parentFrame() && inApp(f.parentFrame()!));
    const text = async () =>
        (await Promise.all(alice.frames().filter(inApp).map((f) => f.evaluate(() => document.body?.innerText ?? "").catch(() => "")))).join("\n");
    await alice.waitForTimeout(20_000);
    const all = await text();
    console.log(all.split("\n").filter((l) => /GOOD|BAD|RTC|iframe/i.test(l)).join("\n"));
    expect(all).toMatch(/GOOD/);
    expect(all.split("\n").filter((l) => /\bBAD\b/.test(l))).toEqual([]);
    await alice.screenshot({ path: "test/real/webrtc-guard.png" });
});
