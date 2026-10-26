import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";

const NS = "de.datanauten.webxdc";
const ROOM = "!room:example.org";

/** The fixture app (test/e2e/fixture-app) as an .xdc. */
function fixtureXdc(): Buffer {
    const dir = new URL("./fixture-app/", import.meta.url).pathname;
    const files: Record<string, Uint8Array> = {};
    const walk = (d: string) => {
        for (const name of readdirSync(d)) {
            const p = join(d, name);
            if (statSync(p).isDirectory()) walk(p);
            else files[relative(dir, p)] = readFileSync(p);
        }
    };
    walk(dir);
    return Buffer.from(zipSync(files));
}

const xdc = fixtureXdc();
const sha256 = createHash("sha256").update(xdc).digest("hex");

const stateEvent = (type: string, stateKey: string, content: unknown, sender = "@alice:example.org") => ({
    type,
    state_key: stateKey,
    content,
    sender,
    event_id: `$${type}-${stateKey}`,
    room_id: ROOM,
    origin_server_ts: Date.now(),
    unsigned: {},
});

const roomState = [
    stateEvent(`${NS}.instance`, "inst1", { v: 1, name: "Fixture", mxc: "mxc://example.org/app", sha256, size: xdc.length }),
    stateEvent("m.room.member", "@alice:example.org", { membership: "join", displayname: "Alice" }),
    stateEvent("m.room.member", "@bob:example.org", { membership: "join", displayname: "Bob" }, "@bob:example.org"),
];

async function openHost(page: Page, fixture: Record<string, unknown> = {}): Promise<void> {
    await page.addInitScript((f) => ((window as unknown as { __TEST_FIXTURE__: unknown }).__TEST_FIXTURE__ = f), {
        params: { matrix_user_id: "@alice:example.org", matrix_display_name: "Alice" },
        state: roomState,
        bodies: { "mxc://example.org/app": xdc.toString("base64") },
        // WIDGET_URL: the deployed widget (live check); MARCADE_LAYOUT: the store's layout, locally.
        ...(process.env.WIDGET_URL ? { widgetPath: process.env.WIDGET_URL } : process.env.MARCADE_LAYOUT ? { widgetPath: "/0.1.0/index.html" } : {}),
        ...fixture,
    });
    await page.goto("/__test__/index.html");
}

const widget = (page: Page) => page.frameLocator("iframe");
const app = (page: Page) => widget(page).frameLocator("iframe");
const sent = (page: Page) => page.evaluate(() => (window as unknown as { __SENT__: { type: string; content: any }[] }).__SENT__);

test("plays an app from the room: files, identity, updates both ways, second page", async ({ page }) => {
    await openHost(page);
    await widget(page).getByRole("button", { name: "Start" }).click();

    // Served from the .xdc by the service worker on the runner origin.
    await expect(app(page).locator("#me")).toHaveText("Alice / sender / 32");
    await expect(app(page).locator("#me")).toHaveCSS("color", "rgb(0, 128, 0)");
    await expect.poll(() => app(page).locator("#local-img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(8);
    await expect(app(page).locator("body")).toHaveAttribute("data-listening", "1");

    // First open on this device: ask the room for history.
    await expect.poll(async () => (await sent(page)).some((s) => s.type === `${NS}.sync` && s.content.kind === "request")).toBe(true);

    await app(page).getByRole("button", { name: "send" }).click();
    await expect(app(page).locator("#log li")).toHaveText(['1/1: {"by":"Alice"}']);
    await expect
        .poll(async () => (await sent(page)).find((s) => s.type === `${NS}.update`)?.content)
        .toMatchObject({ v: 1, instance: "inst1", updates: [{ payload: { by: "Alice" }, summary: "1 click" }] });
    await expect
        .poll(async () => (await sent(page)).find((s) => s.type === "m.room.message")?.content)
        .toEqual({ msgtype: "m.notice", body: "Fixture: someone clicked" });

    // Bob's update arrives from the room.
    await page.evaluate((room) => {
        (window as unknown as { __toWidget: (a: string, d: unknown) => void }).__toWidget("send_event", {
            type: "de.datanauten.webxdc.update",
            content: { v: 1, instance: "inst1", updates: [{ id: "bob-1", payload: { by: "Bob" } }] },
            sender: "@bob:example.org",
            event_id: "$bob1",
            room_id: room,
            origin_server_ts: Date.now(),
        });
    }, ROOM);
    await expect(app(page).locator("#log li")).toHaveText(['1/1: {"by":"Alice"}', '2/2: {"by":"Bob"}']);
    await expect(widget(page).locator(".player-bar")).toContainText("1 click");

    // A second page of the app (file name with a space) gets webxdc too.
    await app(page).getByRole("link", { name: "page 2" }).click();
    await expect(app(page).locator("#p2")).toHaveText("page 2 sees serial 2");
});

test("keeps the app offline and asks before opening links", async ({ page, context }) => {
    const leaks: string[] = [];
    await context.route(/example\.org/, (route) => {
        leaks.push(route.request().url());
        return route.fulfill({ status: 200, body: "leaked" });
    });
    await openHost(page);
    await widget(page).getByRole("button", { name: "Start" }).click();
    await expect(app(page).locator("#me")).toContainText("Alice");

    await app(page).getByRole("button", { name: "fetch out" }).click();
    await expect(app(page).locator("#netout")).toHaveText("fetch blocked");
    await app(page).getByRole("button", { name: "image out" }).click();
    await expect(app(page).locator("#netout")).toHaveText("image blocked");

    await app(page).getByRole("link", { name: "external link" }).click();
    const dialog = widget(page).getByRole("alertdialog");
    await expect(dialog).toContainText("https://webxdc.org/");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // Navigating its own frame elsewhere is stopped by the widget's frame-src.
    await app(page).getByRole("button", { name: "navigate out" }).click();
    await page.waitForTimeout(1000);
    expect(leaks).toEqual([]);
});

test("keeps the update log across reloads", async ({ page }) => {
    await openHost(page);
    await widget(page).getByRole("button", { name: "Start" }).click();
    await app(page).getByRole("button", { name: "send" }).click();
    await expect(app(page).locator("#log li")).toHaveCount(1);

    await page.reload();
    await widget(page).getByRole("button", { name: "Start" }).click();
    await expect(app(page).locator("#log li")).toHaveText(['1/1: {"by":"Alice"}']);
    // localStorage is the app's own (namespaced per instance on the shared runner origin).
    await expect(app(page).locator("#storage")).toHaveText("ls keys: opened");
});

test("adds an app from a file", async ({ page }) => {
    await openHost(page, { state: roomState.slice(1) });
    await expect(widget(page).getByText("No apps in this room yet.")).toBeVisible();
    await widget(page).getByRole("button", { name: "Add app" }).click();
    await widget(page).getByRole("tab", { name: "File" }).click();
    await widget(page).locator('input[type="file"]').setInputFiles({ name: "fixture.xdc", mimeType: "application/zip", buffer: xdc });
    await expect(widget(page).getByRole("region", { name: "App to add" })).toContainText("5 files");
    await widget(page).getByRole("button", { name: "Add to room" }).click();

    await expect(app(page).locator("#me")).toHaveText("Alice / sender / 32");
    const state = (await sent(page)).find((s) => s.type === `${NS}.instance`)!;
    expect(state.content).toMatchObject({ v: 1, name: "fixture", sha256, size: xdc.length, mxc: "mxc://example.org/uploaded-1" });
    const uploads = await page.evaluate(() => (window as unknown as { __UPLOADS__: Uint8Array[] }).__UPLOADS__.length);
    expect(uploads).toBe(1);
});

test("a pinned tile asks only for its own app", async ({ page }) => {
    await openHost(page, { params: { matrix_user_id: "@bob:example.org", instance: "inst1" } });
    await expect(app(page).locator("#me")).toHaveText("Bob / receiver / 32");
    const caps = await page.evaluate(() => (window as unknown as { __REQUESTED_CAPABILITIES__: string[] }).__REQUESTED_CAPABILITIES__);
    expect(caps).toContain(`org.matrix.msc2762.receive.state_event:${NS}.instance#inst1`);
    expect(caps.some((c) => c.startsWith("org.matrix.msc2762.send.state_event"))).toBe(false);
});

test("opened from a bare URL, it adds the identity template to its own widget event", async ({ page }) => {
    const own = stateEvent("im.vector.modular.widgets", "test-widget", { type: "m.custom", url: "https://webxdc.example/0.1.0/", name: "Custom", data: {} });
    await openHost(page, { params: {}, events: [own] });
    await expect(widget(page).getByText("Setting up")).toBeVisible();
    await expect(widget(page).getByRole("button", { name: "Start" })).toBeDisabled();
    const write = (await sent(page)).find((s) => s.type === "im.vector.modular.widgets") as { state_key?: string; content: unknown };
    expect(write.state_key).toBe("test-widget");
    expect(write.content).toMatchObject({
        url: "https://webxdc.example/0.1.0/#/?matrix_user_id=$matrix_user_id&matrix_display_name=$matrix_display_name&theme=$org.matrix.msc2873.client_theme",
        name: "webxdc apps",
    });
});
