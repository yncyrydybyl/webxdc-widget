/*
 * Real apps from the webxdc.org catalog (network). Run with NETWORK=1.
 * Alice adds an app through the catalog UI; Bob, on another "device" (browser
 * context), gets the room state and Alice's events relayed by the test.
 */
import { expect, test } from "@playwright/test";
import { addFromCatalog, app, host, logProblems, NS, relay, roomOf, widget, type W } from "./real";

test.skip(!process.env.NETWORK, "needs the network: NETWORK=1");

test("real catalog apps start in the player", async ({ browser }) => {
    test.setTimeout(180_000);
    const alice = await host(browser, "@alice:example.org", "Alice");
    logProblems(alice);
    for (const [search, pick] of [
        ["checklist", /^Checklist\b/],
        ["poll", /^Poll\b/],
        ["chess", /^Chess\b/],
        ["editor", /^Editor\b/],
        ["excalidraw", /^Excalidraw\b/],
        ["tower", /^Tower Builder\b/],
    ] as const) {
        await addFromCatalog(alice, search, pick);
        await expect(widget(alice).locator(".player-stage .overlay")).toHaveCount(0, { timeout: 20_000 });
        await alice.waitForTimeout(2500); // Excalidraw waits 2 s for realtime peers
        await alice.screenshot({ path: `test/real/app-${search}.png` });
        expect((await app(alice).locator("body").innerHTML()).length).toBeGreaterThan(400);
        await widget(alice).getByRole("button", { name: "Back to the room's apps" }).click();
    }
    await alice.screenshot({ path: "test/real/library.png" });
});

test("two people share a Checklist from the catalog", async ({ browser }) => {
    test.setTimeout(90_000);
    const alice = await host(browser, "@alice:example.org", "Alice");
    await addFromCatalog(alice, "checklist", /^Checklist\b/);
    await app(alice).locator("#AppCreateField").fill("Buy milk");
    await app(alice).getByRole("button", { name: "Add Item" }).click();
    await expect(app(alice).locator("#AppList")).toContainText("Buy milk");
    // The update reaches the room as an event (bucket permitting).
    await expect.poll(async () => (await alice.evaluate(() => (window as W).__SENT__)).some((s: any) => s.type === `${NS}.update`)).toBe(true);

    // Bob, on another device: the room has Alice's instance and .xdc.
    const bob = await host(browser, "@bob:example.org", "Bob", await roomOf(alice));
    await widget(bob).getByRole("button", { name: "Start" }).click();
    await expect(app(bob).locator("#AppCreateField")).toBeVisible();
    let seen = await relay(alice, bob, "@alice:example.org");
    await expect(app(bob).locator("#AppList")).toContainText("Buy milk");

    // Bob adds one; it travels back to Alice.
    await app(bob).locator("#AppCreateField").fill("Bake bread");
    await app(bob).getByRole("button", { name: "Add Item" }).click();
    await expect.poll(async () => (await bob.evaluate(() => (window as W).__SENT__)).filter((s: any) => s.type === `${NS}.update`).length).toBeGreaterThan(0);
    await relay(bob, alice, "@bob:example.org");
    await expect(app(alice).locator("#AppList")).toContainText("Bake bread");
    seen = await relay(alice, bob, "@alice:example.org", seen);

    await alice.screenshot({ path: "test/real/checklist-alice.png" });
    await bob.screenshot({ path: "test/real/checklist-bob.png" });
    await widget(alice).getByRole("button", { name: "Back to the room's apps" }).click();
    await alice.screenshot({ path: "test/real/library.png" });
});
