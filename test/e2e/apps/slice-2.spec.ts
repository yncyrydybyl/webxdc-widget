/*
 * Deep test, slice 2: one meaningful interaction per catalog app, and for apps
 * that share state through webxdc updates, that the change reaches Bob after
 * relay(). Needs the .xdc files from scripts/fetch-catalog.mjs in
 * test/real/all/xdc/. Each test logs what it observed ("[<id>] {...}": page
 * errors, CSP refusals, extra values); the verdicts are judged from that into
 * test/real/all/deep/<id>.json. SHOTS=<dir> saves screenshots.
 *
 * Apps that never load webxdc.js (Mahjong, Memory Blocks, MARL) stay behind the
 * widget's "Starting …" overlay; their tests record that and then remove the
 * overlay to check that the app underneath works.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { app, host, relay, widget } from "../real";
import { addXdc, ALICE, BOB, appFrame, chats, covered, dump, hasXdc, overlay, press, reacts, shot, stage, startPeer, toDevice, uncover as hideCover, updates, watch, type Log } from "./lib";

test.describe.configure({ mode: "parallel" });
test.skip(!hasXdc("webxdc-checklist"), "needs node scripts/fetch-catalog.mjs");

/** Bob, on another device, opens Alice's app; everything Alice sent so far is relayed. */
async function bobJoins(alice: Page) {
    const { page: bob, frame } = await startPeer(alice);
    const p = watch(bob, "bob");
    const seen = await relay(alice, bob, ALICE);
    return { bob, frame, seen, p };
}

/** Logs what was observed, for the per-app JSON. */
function report(id: string, p: Log[], extra: Record<string, unknown> = {}): void {
    console.log(`[${id}] ${JSON.stringify({ ...extra, errors: p.flatMap((x) => x.errors).slice(0, 8), blocked: p.flatMap((x) => x.blocked).slice(0, 5) })}`);
}

async function begin(browser: Browser, id: string, running = true) {
    const alice = await host(browser, ALICE, "Alice");
    const p = watch(alice, "alice");
    const frame = await addXdc(alice, id, running);
    return { alice, frame, p };
}

/** Hides the "Starting …" cover if it is still there (lib's `uncover` waits for one). */
const uncover = async (page: Page): Promise<void> => void ((await covered(page)) && (await hideCover(page)));

/** The app's canvas, where games read presses. */
const canvas = (page: Page) => app(page).locator("canvas").first();

// ---------------------------------------------------------------- tools

test("webxdc-checklist", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "webxdc-checklist";
    const { alice, p } = await begin(browser, id);
    await app(alice).locator("#AppCreateField").fill("Buy milk");
    await app(alice).getByRole("button", { name: "Add Item" }).click();
    await expect(app(alice).locator("#AppList")).toContainText("Buy milk");
    await expect.poll(async () => (await updates(alice)).length).toBeGreaterThan(0);
    const { bob, p: pb } = await bobJoins(alice);
    await expect(app(bob).locator("#AppList")).toContainText("Buy milk");
    await shot(bob, id);
    report(id, [p, pb]);
});

test("anedroid-birthday-order", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "anedroid-birthday-order";
    const { alice, p } = await begin(browser, id);
    await app(alice).locator("#ItemNameField").fill("Red bicycle");
    await app(alice).locator("#ItemURLField").fill("https://example.org/bike");
    await app(alice).locator("#AddItemButton").click();
    await expect(app(alice).locator("#SetupList")).toContainText("Red bicycle");
    await expect.poll(async () => (await updates(alice)).length).toBeGreaterThan(1);
    const { bob, p: pb } = await bobJoins(alice);
    // Bob is not the admin: he sees the check list, not the setup.
    await expect(app(bob).locator("#CheckList")).toContainText("Red bicycle");
    await app(bob).locator("#CheckList input[type=checkbox]").first().check();
    await expect.poll(async () => (await updates(bob)).length).toBeGreaterThan(0);
    await shot(bob, id);
    report(id, [p, pb]);
});

test("breisa-betterlist", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "breisa-betterlist";
    const { alice, p } = await begin(browser, id);
    await app(alice).locator("#new-item-input").fill("Oat milk");
    await app(alice).locator("#add-btn").click();
    await expect(app(alice).locator("#item-list")).toContainText("Oat milk");
    await expect.poll(async () => (await updates(alice)).length).toBeGreaterThan(1);
    const { bob, p: pb } = await bobJoins(alice);
    await expect(app(bob).locator("#item-list")).toContainText("Oat milk");
    // Bob adds one; it travels back to Alice.
    await app(bob).locator("#new-item-input").fill("Bread");
    await app(bob).locator("#add-btn").click();
    await expect.poll(async () => (await updates(bob)).length).toBeGreaterThan(0);
    await relay(bob, alice, BOB);
    await expect(app(alice).locator("#item-list")).toContainText("Bread");
    await shot(alice, id);
    report(id, [p, pb]);
});

test("featherwiki", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "featherwiki";
    const { alice, p } = await begin(browser, id);
    await app(alice).getByText("New Page").first().click();
    await app(alice).locator("#np").fill("Groceries");
    await app(alice).locator("#np").press("Enter");
    await app(alice).locator(".ed-uc").first().click();
    await alice.keyboard.type("Milk and eggs");
    await app(alice).getByRole("button", { name: "Save" }).click();
    await expect(app(alice).locator("body")).toContainText("Milk and eggs");
    await expect.poll(async () => (await updates(alice)).length).toBeGreaterThan(0);
    const { bob, p: pb } = await bobJoins(alice);
    await app(bob).getByRole("link", { name: "Groceries" }).first().click();
    await expect(app(bob).locator("body")).toContainText("Milk and eggs");
    await shot(bob, id);
    report(id, [p, pb]);
});

/** Answers the widget's "Send to the room?" dialog and waits for the m.room.message. */
async function sendToRoom(page: Page): Promise<any> {
    const before = (await chats(page)).length;
    const dialog = widget(page).getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Send" }).click();
    await expect.poll(async () => (await chats(page)).length).toBeGreaterThan(before);
    return (await chats(page)).at(-1);
}

test("jooray-nowhere", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "jooray-nowhere";
    const { alice, p } = await begin(browser, id);
    await app(alice).getByRole("button", { name: "message" }).click();
    await app(alice).getByPlaceholder("required").fill("Alice");
    await app(alice).getByPlaceholder("e.g. Weekly update").fill("Lunch plan");
    await app(alice).locator("textarea").fill("Meet at **noon**");
    // "send to chat" shares the link as a webxdc update (info message), not sendToChat.
    await app(alice).getByRole("button", { name: /send to chat/ }).click();
    await expect.poll(async () => (await updates(alice)).length).toBeGreaterThan(0);
    const sent = (await updates(alice)).at(-1)!.content;
    const { bob, frame: fb, p: pb } = await bobJoins(alice);
    // Delta Chat opens the app at the info message's href; the widget has no such
    // path (the notice is plain text), so Bob's app shows its start page.
    const href = (await updates(alice))[0]?.content;
    console.log(`[${id}] update: ${JSON.stringify(href).slice(0, 400)}`);
    console.log(`[${id}] notices: ${JSON.stringify(await chats(alice)).slice(0, 300)}`);
    await expect(app(bob).locator("body")).not.toContainText("Lunch plan");
    // The app itself renders the shared message when opened at that href.
    const hash = String(JSON.stringify(sent).match(/index\.html(#[^"\\]+)/)?.[1] ?? "");
    expect(hash).not.toBe("");
    await fb.evaluate((h) => { location.hash = h; location.reload(); }, hash);
    await expect(app(bob).locator("body")).toContainText("noon", { timeout: 15_000 });
    await shot(bob, id);
    report(id, [p, pb]);
});

test("useroqqq-spoilerapp", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "useroqqq-spoilerapp";
    const { alice, p } = await begin(browser, id);
    await app(alice).locator("input[type=file]").first().setInputFiles(`test/real/all/shots/webxdc-checklist.png`);
    await app(alice).getByRole("button", { name: "Send to chat" }).click();
    const msg = await sendToRoom(alice);
    console.log(`[${id}] message: ${JSON.stringify(msg.content).slice(0, 300)}`);
    await shot(alice, id);
    report(id, [p], { updates: (await updates(alice)).length });
});

test("durian-ice", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "durian-ice";
    const { alice, frame, p } = await begin(browser, id);
    await app(alice).locator("#size").fill("3 officers");
    await app(alice).locator("input.primary[type=button]").click();
    const msg = await sendToRoom(alice);
    console.log(`[${id}] message: ${JSON.stringify(msg.content).slice(0, 300)}`);
    expect(JSON.stringify(msg.content)).toContain("3 officers");
    await shot(alice, id);
    report(id, [p], { updates: (await updates(alice)).length, buttons: await frame.evaluate(() => [...document.querySelectorAll("input[type=button]")].map((b) => (b as HTMLInputElement).value)) });
});

test("webxdc-test", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "webxdc-test";
    const { alice, frame, p } = await begin(browser, id);
    await expect(app(alice).locator("body")).toContainText("updates from previous/current runs");
    await app(alice).getByRole("button", { name: "Send To Chat (text only)" }).click();
    const msg = await sendToRoom(alice);
    console.log(`[${id}] message: ${JSON.stringify(msg.content).slice(0, 300)}`);
    await app(alice).getByRole("button", { name: "Join" }).click();
    await app(alice).getByRole("button", { name: "Send Data" }).click();
    await alice.waitForTimeout(500);
    const realtime = (await toDevice(alice)).length;
    await app(alice).locator("#tab-sandbox").click();
    await alice.waitForTimeout(3000);
    const sandbox = (await frame.evaluate(() => document.body.innerText)).split("\n").filter((l) => /RTCPeerConnection|cookies|iframe:/.test(l));
    const { bob, p: pb } = await bobJoins(alice);
    await expect(app(bob).locator("body")).toContainText("updates from previous/current runs");
    const bobLine = (await app(bob).locator("body").innerText()).split("\n").find((l) => /updates from previous/.test(l));
    await shot(alice, id);
    report(id, [p, pb], { updates: (await updates(alice)).length, toDevice: realtime, sandbox, bobLine });
});

test("omidz4t-planner", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "omidz4t-planner";
    const { alice, frame, p } = await begin(browser, id);
    const n = (await updates(alice)).length;
    await app(alice).locator("textarea.add-task-textarea").fill("Write the report");
    await app(alice).locator("textarea.add-task-textarea").press("Enter");
    await expect(app(alice).locator("body")).toContainText("Write the report");
    await expect.poll(async () => (await updates(alice)).length).toBeGreaterThan(n);
    const { bob, p: pb } = await bobJoins(alice);
    await expect(app(bob).locator("body")).toContainText("Write the report", { timeout: 15_000 }).catch(async (e) => {
        await dump(frame, "alice");
        await shot(bob, `${id}-bob`);
        throw e;
    });
    await shot(bob, id);
    report(id, [p, pb]);
});

test("durian-time", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "durian-time";
    const { alice, p } = await begin(browser, id);
    await app(alice).locator("select").first().selectOption("Asia/Tokyo");
    await app(alice).getByRole("button", { name: "Share time zone" }).click();
    await expect.poll(async () => (await updates(alice)).length).toBeGreaterThan(0);
    await expect(app(alice).locator("body")).toContainText("Alice");
    const { bob, p: pb } = await bobJoins(alice);
    await expect(app(bob).locator("body")).toContainText("Alice");
    await expect(app(bob).locator("body")).toContainText("Asia/Tokyo");
    await shot(bob, id);
    report(id, [p, pb]);
});

test("maplediss-quiet-journal", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "maplediss-quiet-journal";
    const { alice, p } = await begin(browser, id);
    await app(alice).locator("#text").click();
    await alice.keyboard.type("A quiet morning by the lake.");
    await app(alice).locator("#postbtn").click();
    await expect(app(alice).locator("body")).toContainText("A quiet morning by the lake.");
    await expect.poll(async () => (await updates(alice)).length).toBeGreaterThan(0);
    const { bob, p: pb } = await bobJoins(alice);
    await expect(app(bob).locator("body")).toContainText("A quiet morning by the lake.");
    await shot(bob, id);
    report(id, [p, pb]);
});

test("arcanecircle-po12", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "arcanecircle-po12";
    const { alice, frame, p } = await begin(browser, id);
    await app(alice).getByRole("button", { name: "no", exact: true }).click();
    const before = await frame.evaluate(() => document.body.innerHTML.length);
    const cls = () => frame.evaluate(() => [...document.querySelectorAll("[id^=soundButton], #playButton")].map((e) => e.className).join("|"));
    const c0 = await cls();
    await app(alice).locator("#soundButton-1").click();
    await app(alice).locator("#playButton").click();
    await alice.waitForTimeout(800);
    const c1 = await cls();
    const audio = await frame.evaluate("typeof AudioContext !== 'undefined'");
    await shot(alice, id);
    expect(c1).not.toBe(c0);
    report(id, [p], { before, changed: c0 !== c1, audio });
});

test("s427-marl", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "s427-marl";
    const { alice, frame, p } = await begin(browser, id, false);
    await alice.waitForTimeout(8000);
    const cover = await covered(alice);
    const overlayText = cover ? await overlay(alice).innerText() : "";
    // Under the overlay, the app itself runs: the theme switch works.
    await app(alice).locator("button.switch-theme").dispatchEvent("click");
    await alice.waitForTimeout(300);
    const theme = await frame.evaluate(() => document.documentElement.className + " " + document.body.className + " " + (document.documentElement.dataset.theme ?? ""));
    await shot(alice, id);
    report(id, [p], { covered: cover, overlayText, theme });
});

// ---------------------------------------------------------------- games

/** A picture of the app frame, to tell whether a canvas game reacted. */
const snap = (page: Page) => stage(page).screenshot();

/** Waits for a score update, relays it to a new Bob and returns Bob's app text. */
async function scoreReachesBob(alice: Page, timeout = 30_000) {
    await expect.poll(async () => (await updates(alice)).length, { timeout }).toBeGreaterThan(0);
    const { bob, frame, p } = await bobJoins(alice);
    await bob.waitForTimeout(1500);
    return { bob, frame, p, text: await frame.evaluate(() => document.body.innerText) };
}

/**
 * Runs in the Snake frame: finds the head (brightest white tile) and the food
 * (the coloured tile), turns toward the food once in line with it, and after the
 * first food reverses into its own body. The arrow buttons turn relative to the snake.
 */
const SNAKE_PILOT = `(() => {
    const turn = (side) => document.getElementById(side).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const tiles = () => [...document.querySelectorAll("body *")].filter((e) => e.style && e.style.left);
    let prev = null, last = "", done = false;
    const t = setInterval(() => {
        const all = tiles();
        const food = all.find((e) => /scale/.test(e.style.transform));
        const white = all.filter((e) => e !== food && /rgba?\\(255, 255, 255/.test(e.style.backgroundColor));
        if (!white.length || !food) return;
        const alpha = (e) => parseFloat(e.style.backgroundColor.split(",")[3] || "1");
        const head = white.reduce((a, b) => (alpha(b) > alpha(a) ? b : a));
        const h = { x: parseFloat(head.style.left), y: parseFloat(head.style.top) };
        const f = { x: parseFloat(food.style.left), y: parseFloat(food.style.top) };
        const score = Number((document.body.innerText.match(/\\d+/) || ["0"])[0]);
        if (score > 0 && !done) { done = true; turn("left"); turn("left"); clearInterval(t); return; }
        if (!prev || (prev.x === h.x && prev.y === h.y)) { prev = prev || h; return; }
        const dir = Math.abs(h.x - prev.x) > Math.abs(h.y - prev.y) ? (h.x > prev.x ? "e" : "w") : (h.y > prev.y ? "s" : "n");
        const key = h.x + "," + h.y;
        prev = h;
        if (key === last) return;
        if ((dir === "e" || dir === "w") && Math.abs(h.x - f.x) < 2) {
            last = key;
            const up = f.y < h.y;
            turn(dir === "e" ? (up ? "left" : "right") : (up ? "right" : "left"));
        } else if ((dir === "n" || dir === "s") && Math.abs(h.y - f.y) < 2) {
            last = key;
            const west = f.x < h.x;
            turn(dir === "n" ? (west ? "left" : "right") : (west ? "right" : "left"));
        }
    }, 15);
})()`;

test("arcanecircle-snake", async ({ browser }) => {
    test.setTimeout(120_000);
    const id = "arcanecircle-snake";
    const { alice, frame, p } = await begin(browser, id);
    const a = await snap(alice);
    await app(alice).locator(".startBtn").click();
    await alice.waitForTimeout(1500);
    expect(a.equals(await snap(alice))).toBe(false);
    // A score of 0 is not sent: steer to one food, then reverse into the own body
    // (two left turns in one tick). Game over sends the score.
    await frame.evaluate(SNAKE_PILOT);
    const { bob, text, p: pb } = await scoreReachesBob(alice, 5000);
    // Bob plays a round too: his game-over scoreboard lists Alice.
    await app(bob).locator(".startBtn").click();
    await (await appFrame(bob)).evaluate(SNAKE_PILOT);
    await expect.poll(async () => (await updates(bob)).length, { timeout: 30_000 }).toBeGreaterThan(0);
    await bob.waitForTimeout(1000);
    console.log(`[${id}] bob after his game: ${(await app(bob).locator("body").innerText()).slice(0, 300)}`);
    console.log(`[${id}] bob's scores: ${JSON.stringify(await app(bob).locator("body").evaluate(() => (window as any).highscores?.getHighScores?.()))}`);
    console.log(`[${id}] alice: ${(await frame.evaluate(() => document.body.innerText)).slice(0, 200)} | bob: ${text.slice(0, 200)} | update: ${JSON.stringify((await updates(alice))[0].content).slice(0, 300)}`);
    await shot(alice, id);
    await shot(bob, `${id}-bob`);
    report(id, [p, pb]);
});

test("arcanecircle-coloron", async ({ browser }) => {
    test.setTimeout(120_000);
    const id = "arcanecircle-coloron";
    const { alice, frame, p } = await begin(browser, id);
    await app(alice).locator("a.play-button").click();
    await alice.waitForTimeout(500);
    await alice.mouse.click(450, 400);
    const { bob, text, p: pb } = await scoreReachesBob(alice);
    console.log(`[${id}] alice: ${(await frame.evaluate(() => document.body.innerText)).slice(0, 300)} | bob: ${text.slice(0, 300)}`);
    // Bob plays a round too: his game-over screen lists Alice's score.
    await app(bob).locator("a.play-button").click();
    await bob.waitForTimeout(500);
    await bob.mouse.click(450, 400);
    await expect(app(bob).locator("a.play-again")).toBeVisible({ timeout: 30_000 });
    await bob.waitForTimeout(1000);
    console.log(`[${id}] bob after his game: ${(await app(bob).locator("body").innerText()).slice(0, 300)}`);
    console.log(`[${id}] bob's scores: ${JSON.stringify(await app(bob).locator("body").evaluate(() => (window as any).highscores?.getHighScores?.()))}`);
    await shot(alice, id);
    await shot(bob, `${id}-bob`);
    report(id, [p, pb]);
});

test("arcanecircle-2048", async ({ browser }) => {
    test.setTimeout(150_000);
    const id = "arcanecircle-2048";
    const { alice, frame, p } = await begin(browser, id);
    const board = () => frame.evaluate(() => document.querySelector(".tile-container")?.innerHTML ?? document.body.innerHTML);
    const b0 = await board();
    await app(alice).locator("body").click({ position: { x: 5, y: 5 } });
    const keys = ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"];
    await alice.keyboard.press("ArrowLeft");
    await alice.keyboard.press("ArrowUp");
    await alice.waitForTimeout(300);
    expect(await board()).not.toBe(b0);
    // Mash until the board is full: game over sends the score.
    for (let i = 0; i < 1500 && !(await updates(alice)).length; i++) {
        await alice.keyboard.press(keys[i % 4 === 3 ? 2 : i % 2]);
        if (i % 50 === 49) await alice.keyboard.press("ArrowRight");
    }
    const { bob, text, p: pb } = await scoreReachesBob(alice, 5000);
    console.log(`[${id}] alice: ${(await frame.evaluate(() => document.body.innerText)).slice(0, 300)} | bob: ${text.slice(0, 300)}`);
    await shot(alice, id);
    await shot(bob, `${id}-bob`);
    report(id, [p, pb]);
});

test("arcanecircle-blackcat", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "arcanecircle-blackcat";
    const { alice, p } = await begin(browser, id);
    const start = await reacts(alice, stage(alice), () => press(alice, canvas(alice)), 1500);
    const space = await reacts(alice, stage(alice), () => alice.keyboard.press("Space"), 1000);
    const move = await reacts(alice, stage(alice), async () => {
        await alice.keyboard.down("ArrowRight");
        await alice.waitForTimeout(600);
        await alice.keyboard.up("ArrowRight");
        await alice.keyboard.press("ArrowUp");
    }, 800);
    await shot(alice, id);
    report(id, [p], { start, space, move });
    expect(start.changed).toBe(true);
});

test("arcanecircle-super-bunny", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "arcanecircle-super-bunny";
    const { alice, frame, p } = await begin(browser, id);
    const start = await reacts(alice, stage(alice), async () => {
        await press(alice, app(alice).locator("body"));
        await alice.keyboard.press("Space");
        await alice.keyboard.press("Enter");
    }, 1500);
    const move = await reacts(alice, stage(alice), async () => {
        await alice.keyboard.down("ArrowRight");
        await alice.waitForTimeout(600);
        await alice.keyboard.up("ArrowRight");
    }, 800);
    await shot(alice, id);
    report(id, [p], { start, move, text: (await frame.evaluate(() => document.body.innerText)).slice(0, 200) });
    expect(start.changed || move.changed).toBe(true);
});

test("r10s-packabunchas", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "r10s-packabunchas";
    const { alice, p } = await begin(browser, id);
    const start = await reacts(alice, stage(alice), () => press(alice, canvas(alice), 0.5, 0.9), 1500);
    const tap = await reacts(alice, stage(alice), () => press(alice, canvas(alice), 0.5, 0.5), 1500);
    await shot(alice, id);
    report(id, [p], { start, tap });
    expect(start.changed).toBe(true);
});

test("arcanecircle-the-cube", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "arcanecircle-the-cube";
    const { alice, frame, p } = await begin(browser, id);
    const start = await reacts(alice, stage(alice), async () => {
        await app(alice).locator("body").dblclick({ position: { x: 450, y: 350 } });
    }, 2500);
    const drag = await reacts(alice, stage(alice), async () => {
        await alice.mouse.move(450, 450);
        await alice.mouse.down();
        await alice.mouse.move(600, 460, { steps: 10 });
        await alice.mouse.up();
    }, 1500);
    await shot(alice, id);
    report(id, [p], { start, drag, text: (await frame.evaluate(() => document.body.innerText)).slice(0, 200), updates: (await updates(alice)).length });
    expect(start.changed).toBe(true);
});

test("befrost-ignota", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "befrost-ignota";
    const { alice, p } = await begin(browser, id);
    // START sits left of the middle of the canvas (see the smoke screenshot).
    const start = await reacts(alice, stage(alice), () => press(alice, canvas(alice), 0.22, 0.48), 1500);
    const note = await reacts(alice, stage(alice), () => press(alice, canvas(alice), 0.08, 0.87), 1500);
    await shot(alice, id);
    report(id, [p], { start, note });
    expect(start.changed || note.changed).toBe(true);
});

test("arcanecircle-pixel-dungeon", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "arcanecircle-pixel-dungeon";
    const { alice, p } = await begin(browser, id);
    await alice.waitForTimeout(3000);
    // "Play" is the first of the four buttons under the logo.
    const play = await reacts(alice, stage(alice), () => press(alice, canvas(alice), 0.255, 0.58), 2500);
    await shot(alice, id);
    report(id, [p], { play });
    expect(play.changed).toBe(true);
});

test("arcanecircle-fspider", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "arcanecircle-fspider";
    const { alice, frame, p } = await begin(browser, id);
    const deal = await reacts(alice, stage(alice), async () => {
        await app(alice).locator("#glbl-game-new-game-btn").click();
    }, 2500);
    await shot(alice, `${id}-dealt`);
    const moves0 = await frame.evaluate(() => document.body.innerText.match(/Moves\s*(\d+)/)?.[1]);
    // Click the stock (bottom right) to deal a row; then try a drag between columns.
    await alice.waitForTimeout(6000);
    const before = await snap(alice);
    await alice.mouse.click(725, 47 + 0.92 * 713);
    await alice.waitForTimeout(4000);
    const stock = !before.equals(await snap(alice));
    const moves1 = await frame.evaluate(() => document.body.innerText.match(/Moves\s*(\d+)/)?.[1]);
    await shot(alice, id);
    report(id, [p], { deal, stock, moves0, moves1, system: await frame.evaluate("typeof System") });
});

for (const id of ["arcanecircle-babeldungeon", "arcanecircle-babeldungeon-eo-en"]) {
    test(id, async ({ browser }) => {
        test.setTimeout(90_000);
        const { alice, p } = await begin(browser, id);
        await app(alice).getByRole("button", { name: "New Game" }).click();
        await alice.waitForTimeout(800);
        await app(alice).locator("button").first().click();
        await alice.waitForTimeout(1500);
        await app(alice).locator("button").last().click();
        await app(alice).getByRole("button", { name: /Easy/ }).click();
        await expect(app(alice).getByRole("button", { name: "Reveal" })).toBeVisible();
        await app(alice).getByRole("button", { name: "Reveal" }).click();
        await expect(app(alice).locator("body")).toContainText("Did you know it?");
        await shot(alice, `${id}-play`);
        report(id, [p], { updates: (await updates(alice)).length });
    });
}

test("arcanecircle-mah", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "arcanecircle-mah";
    const { alice, frame, p } = await begin(browser, id, false);
    await alice.waitForTimeout(8000);
    const cover = await covered(alice);
    const overlayText = cover ? await overlay(alice).innerText() : "";
    await shot(alice, `${id}-covered`);
    await uncover(alice);
    await app(alice).getByRole("button", { name: "Start Random" }).click();
    await alice.waitForTimeout(1500);
    const stones = () => frame.evaluate(() => document.body.innerText.match(/Stones:\s*(\d+)/)?.[1]);
    const s0 = await stones();
    // Ask for a hint, then click the two hinted stones.
    await app(alice).getByRole("button", { name: "Hint" }).click();
    await alice.waitForTimeout(500);
    const hinted = await frame.evaluate(() => document.querySelectorAll("[class*=hint]").length);
    const hints = app(alice).locator("[class*=hint]");
    console.log(`[${id}] hint classes: ${await hints.first().getAttribute("class")}`);
    await hints.nth(0).click();
    await hints.nth(1).click().catch(() => app(alice).locator("[class*=hint]").first().click());
    await alice.waitForTimeout(1000);
    const s1 = await stones();
    console.log(`[${id}] stones ${s0} -> ${s1}`);
    await shot(alice, id);
    report(id, [p], { covered: cover, overlayText, s0, hinted });
});

test("memory-blocks", async ({ browser }) => {
    test.setTimeout(90_000);
    const id = "memory-blocks";
    const { alice, frame, p } = await begin(browser, id, false);
    await alice.waitForTimeout(8000);
    const cover = await covered(alice);
    const overlayText = cover ? await overlay(alice).innerText() : "";
    await uncover(alice);
    await app(alice).locator("svg").first().click();
    await alice.waitForTimeout(2500);
    const after = await frame.evaluate(() => ({ text: document.body.innerText.slice(0, 200), rects: document.querySelectorAll("svg rect").length }));
    await shot(alice, id);
    report(id, [p], { covered: cover, overlayText, after });
});

