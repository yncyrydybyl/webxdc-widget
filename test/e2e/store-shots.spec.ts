/*
 * Store screenshots from the mock host with real catalog apps (network):
 *   SHOTS=1 NETWORK=1 pnpm exec playwright test store-shots --project chromium
 * Writes store/screenshots/.
 */
import { expect, test, type Page } from "@playwright/test";

test.skip(!process.env.SHOTS || !process.env.NETWORK, "SHOTS=1 NETWORK=1");

const ROOM = "!room:example.org";
const member = (id: string, name: string) => ({ type: "m.room.member", state_key: id, content: { membership: "join", displayname: name }, sender: id, event_id: `$${name}`, room_id: ROOM, origin_server_ts: 1, unsigned: {} });

async function host(page: Page, theme: string): Promise<void> {
    await page.addInitScript((f) => ((window as any).__TEST_FIXTURE__ = f), {
        params: { matrix_user_id: "@alice:example.org", matrix_display_name: "Alice", theme },
        state: [member("@alice:example.org", "Alice"), member("@bob:example.org", "Bob"), { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" }, sender: "@alice:example.org", event_id: "$enc", room_id: ROOM, origin_server_ts: 1, unsigned: {} }],
    });
    await page.goto("/__test__/index.html");
}
const w = (p: Page) => p.frameLocator("iframe");
const app = (p: Page) => w(p).frameLocator("iframe");

async function add(page: Page, search: string, pick: RegExp): Promise<void> {
    await w(page).getByRole("button", { name: "Add app" }).click();
    await w(page).getByRole("searchbox").fill(search);
    await w(page).getByRole("button", { name: pick }).first().click();
    await w(page).getByRole("button", { name: "Add to room" }).click({ timeout: 20_000 });
    await expect(w(page).locator(".player-stage .overlay")).toHaveCount(0, { timeout: 20_000 });
}

test("store screenshots", async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await host(page, "light");

    await add(page, "chess", /^Chess\b/);
    await w(page).getByRole("button", { name: "Back to the room's apps" }).click();
    await add(page, "poll", /^Poll\b/);
    await w(page).getByRole("button", { name: "Back to the room's apps" }).click();
    await add(page, "checklist", /^Checklist\b/);
    for (const item of ["Book the venue", "Order pizza", "Send invitations"]) {
        await app(page).locator("#AppCreateField").fill(item);
        await app(page).getByRole("button", { name: "Add Item" }).click();
    }
    await app(page).locator("#AppList input[type=checkbox]").first().check();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "store/screenshots/02-checklist.png" });

    await w(page).getByRole("button", { name: "Back to the room's apps" }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: "store/screenshots/01-room-apps.png" });

    await w(page).getByRole("button", { name: "Add app" }).click();
    await expect(w(page).locator(".catalog-item").first()).toBeVisible();
    await page.waitForTimeout(1500); // icons
    await page.screenshot({ path: "store/screenshots/03-catalog.png" });

    // Side-panel width, dark.
    const side = await browser.newContext({ viewport: { width: 420, height: 800 }, deviceScaleFactor: 2, colorScheme: "dark" });
    const sp = await side.newPage();
    await host(sp, "dark");
    await add(sp, "chess", /^Chess\b/);
    await app(sp).getByText("Start Game").click().catch(() => undefined);
    await sp.waitForTimeout(1500);
    await sp.screenshot({ path: "store/screenshots/04-side-panel-dark.png" });
});
