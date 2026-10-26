/*
 * Deep test, slice 3: one meaningful interaction per catalog app, and for apps
 * that share state through webxdc updates, that the change reaches Bob after
 * relay(). Apps come from test/real/all/xdc (node scripts/fetch-catalog.mjs);
 * findings are in test/real/all/deep/<id>.json and slice-3.md.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { app, host, relay, widget } from "../real";
import { addXdc, ALICE, appFrame, BOB, chats, covered, hasXdc, overlay, press, reacts, shot, stage, startPeer, updates, watch, type Peer } from "./lib";

test.describe.configure({ mode: "parallel" });

type Run = Peer & { errors: string[] };

/** This test's people, for the screenshots and error dump after it (pass or fail). */
let runs: Run[] = [];
test.beforeEach(() => {
    runs = [];
});
test.afterEach(async ({}, info) => {
    for (const [i, r] of runs.entries()) {
        await shot(r.page, `${info.title}${i ? "-bob" : ""}`);
        const errs = [...new Set(r.errors)];
        if (errs.length) console.log(`[${info.title}${i ? " bob" : ""}] errors:\n  ${errs.join("\n  ")}`);
    }
});

/** Alice adds the .xdc and starts it (watched from the first request); `running`: wait for the app to load webxdc.js. */
async function start(browser: Browser, id: string, running = true): Promise<Run> {
    test.skip(!hasXdc(id), "node scripts/fetch-catalog.mjs first");
    const page = await host(browser, ALICE, "Alice");
    const { errors } = watch(page);
    const frame = await addXdc(page, id, running);
    const run = { page, frame, app: app(page), errors };
    runs.push(run);
    return run;
}

/** Bob, on another device, opens the app Alice added. */
async function startBob(alice: Page): Promise<Run> {
    const peer = await startPeer(alice);
    const run = { ...peer, errors: watch(peer.page).errors };
    runs.push(run);
    return run;
}

// ---------------------------------------------------------------- games

test("arcanecircle-amazingtrack", async ({ browser }) => {
    // Unity WebGL build; its index.html does not load webxdc.js.
    const a = await start(browser, "arcanecircle-amazingtrack", false);
    await expect.poll(() => a.frame.evaluate(() => !!document.querySelector("canvas") && (document.querySelector("canvas") as HTMLCanvasElement).width > 0), { timeout: 30_000 }).toBe(true);
    await a.page.waitForTimeout(8000);
    // The game runs in the frame, but the widget still shows "Starting…" over it:
    // status turns "running" only when the app's webxdc.js says hello (src/bridge.ts connect()).
    const hidden = await covered(a.page);
    console.log(`[amazingtrack] overlay still visible after 8 s: ${hidden} (${(await overlay(a.page).textContent())?.trim()})`);
    const log = await a.frame.evaluate(() => document.title);
    console.log(`[amazingtrack] title ${log}`);
    expect(hidden, "the app is hidden behind the widget's Starting… overlay").toBe(false);
});

test("arcanecircle-babeldungeon-eu-en", async ({ browser }) => {
    const a = await start(browser, "arcanecircle-babeldungeon-eu-en");
    await a.app.getByRole("button", { name: "New Game" }).click();
    await a.page.waitForTimeout(1500);
    const text = await a.frame.evaluate(() => document.body.innerText.slice(0, 300));
    console.log(`[babeldungeon] after New Game: ${JSON.stringify(text)}`);
    expect(text).not.toContain("Import Game");
    // Choosing the language is stored as an update (the player's progress lives in the log).
    await a.app.getByRole("button", { name: "English" }).click();
    await expect.poll(async () => (await updates(a.page)).length).toBeGreaterThan(0);
    await a.page.waitForTimeout(1000);
    console.log(`[babeldungeon] after English: ${JSON.stringify(await a.frame.evaluate(() => document.body.innerText.slice(0, 200)))}`);
});

test("arcanecircle-back-up", async ({ browser }) => {
    const a = await start(browser, "arcanecircle-back-up");
    await a.page.waitForTimeout(1500);
    await a.app.locator("canvas").click();
    const r = await reacts(a.page, stage(a.page), async () => {
        for (let i = 0; i < 6; i++) await a.page.keyboard.press(i % 2 ? "ArrowLeft" : "ArrowRight");
    });
    console.log(`[back-up] ${JSON.stringify(r)}`);
    expect(r.changed).toBe(true);
});

test("arcanecircle-breakout71", async ({ browser }) => {
    const a = await start(browser, "arcanecircle-breakout71");
    await a.page.waitForTimeout(1500);
    // Move the puck and click to launch the ball.
    const r = await reacts(a.page, stage(a.page), async () => {
        await press(a.page, a.app.locator("canvas").first(), 0.5, 0.9);
        await a.page.mouse.move(400, 600, { steps: 5 });
    }, 1500);
    const score = await a.app.locator("#score").textContent();
    console.log(`[breakout71] ${JSON.stringify(r)} score ${score}`);
    expect(r.changed).toBe(true);
});

test("arcanecircle-coupahoo", async ({ browser }) => {
    const a = await start(browser, "arcanecircle-coupahoo");
    await a.page.waitForTimeout(1500);
    // The ROLL button sits at the bottom right of the canvas.
    const r = await reacts(a.page, stage(a.page), () => press(a.page, a.app.locator("canvas").first(), 0.86, 0.9), 2000);
    console.log(`[coupahoo] ${JSON.stringify(r)}`);
    expect(r.changed).toBe(true);
});

test("arcanecircle-gibbonacci", async ({ browser }) => {
    const a = await start(browser, "arcanecircle-gibbonacci");
    await a.page.waitForTimeout(2000);
    const before = await a.frame.evaluate(() => ({ canvases: document.querySelectorAll("canvas").length, buttons: document.querySelectorAll("button").length, ready: document.readyState }));
    // The legacy bundle starts the game in a DOMContentLoaded listener, but
    // System.import() runs it only after that event: nothing gets drawn.
    await a.frame.evaluate(() => window.dispatchEvent(new Event("DOMContentLoaded")));
    await a.page.waitForTimeout(1000);
    const after = await a.frame.evaluate(() => ({ canvases: document.querySelectorAll("canvas").length, buttons: document.querySelectorAll("button").length }));
    console.log(`[gibbonacci] before ${JSON.stringify(before)} after re-dispatching DOMContentLoaded ${JSON.stringify(after)}`);
    // An app bug (the same in Delta Chat): with the late listener fired, the game is there.
    test.info().annotations.push({ type: "app-bug", description: "game starts on window DOMContentLoaded, which fired before System.import() ran the legacy bundle" });
    expect(before.canvases + before.buttons).toBe(0);
    expect(after.canvases).toBeGreaterThan(0);
});

test("arcanecircle-minesweeper", async ({ browser }) => {
    const a = await start(browser, "arcanecircle-minesweeper");
    await a.app.getByRole("button", { name: "Easy" }).click();
    const cells = a.app.locator("#grid td");
    await expect(cells.first()).toBeVisible();
    const n = await cells.count();
    await cells.nth(Math.floor(n / 2)).click();
    await a.page.waitForTimeout(500);
    const opened = await a.frame.evaluate(() => Array.from(document.querySelectorAll("#grid td")).filter((td) => td.className && !/hidden|covered/.test(td.className)).length);
    const classes = await a.frame.evaluate(() => [...new Set(Array.from(document.querySelectorAll("#grid td")).map((td) => td.className))].join(","));
    console.log(`[minesweeper] cells ${n} opened ${opened} classes ${classes}`);
    expect(classes.split(",").length).toBeGreaterThan(1);
});

test("arcanecircle-power-crisis", async ({ browser }) => {
    const a = await start(browser, "arcanecircle-power-crisis");
    await a.page.waitForTimeout(2000);
    // "Do you want to enable audio?" — NO, then START.
    const r = await reacts(a.page, stage(a.page), async () => {
        await press(a.page, a.app.locator("canvas").first(), 0.448, 0.553);
        await a.page.waitForTimeout(600);
        await press(a.page, a.app.locator("canvas").first(), 0.5, 0.79);
    }, 2000);
    console.log(`[power-crisis] ${JSON.stringify(r)}`);
    expect(r.changed).toBe(true);
});

test("arcanecircle-snakesandladders", async ({ browser }) => {
    const a = await start(browser, "arcanecircle-snakesandladders");
    await a.page.waitForTimeout(1500);
    await a.app.locator("canvas").click();
    const r = await reacts(a.page, stage(a.page), async () => {
        await a.page.keyboard.down("ArrowRight");
        await a.page.waitForTimeout(600);
        await a.page.keyboard.up("ArrowRight");
    });
    console.log(`[snakesandladders] ${JSON.stringify(r)}`);
    expect(r.changed).toBe(true);
});

test("arcanecircle-super-castle", async ({ browser }) => {
    const a = await start(browser, "arcanecircle-super-castle");
    await a.page.waitForTimeout(2000);
    // "START / MUSIC OFF" on the right.
    const r = await reacts(a.page, stage(a.page), () => press(a.page, a.app.locator("canvas").first(), 0.78, 0.74), 2000);
    console.log(`[super-castle] ${JSON.stringify(r)}`);
    expect(r.changed).toBe(true);
});

test("arcanecircle-tictactoe", async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await start(browser, "arcanecircle-tictactoe");
    await a.app.getByText("Create new game offer...").click();
    await expect.poll(async () => (await updates(a.page)).length).toBeGreaterThan(0);
    const b = await startBob(a.page);
    let seenA = await relay(a.page, b.page, ALICE);
    // Bob joins Alice's offer; Alice's app answers with "start".
    await b.app.getByText(/offered a\s+game, tap to join/).click();
    await expect.poll(async () => (await updates(b.page)).length).toBeGreaterThan(0);
    let seenB = await relay(b.page, a.page, BOB);
    await expect.poll(async () => (await updates(a.page)).length, { timeout: 10_000 }).toBeGreaterThan(1);
    seenA = await relay(a.page, b.page, ALICE, seenA);
    await expect(b.app.getByText(/Alice\s+vs\s+Bob/)).toBeVisible();
    await expect(a.app.getByText(/Alice\s+vs\s+Bob/)).toBeVisible();
    void seenB;
});

test("crate-diggers", async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await start(browser, "crate-diggers");
    const b = await startBob(a.page);
    await expect.poll(async () => (await updates(b.page)).length).toBeGreaterThan(0); // Bob's hello
    let seenA = await relay(a.page, b.page, ALICE);
    await relay(b.page, a.page, BOB);
    await expect(a.app.getByText("Bob")).toBeVisible();
    await a.app.getByRole("button", { name: /New Round/ }).click();
    await a.app.locator('[data-action="choose-subject"]', { hasText: "Bob" }).click();
    await expect.poll(async () => (await updates(a.page)).length).toBeGreaterThan(1);
    seenA = await relay(a.page, b.page, ALICE, seenA);
    await expect(b.app.getByText("Which of these would YOU pick?")).toBeVisible();
});

test("mestermim-dots-boxes", async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await start(browser, "mestermim-dots-boxes");
    await a.app.locator("#btn-pvp").click();
    await a.app.locator("#line-0-0-h").click();
    await expect.poll(async () => (await updates(a.page)).length).toBeGreaterThan(0);
    await expect(a.app.locator("#line-0-0-h")).toHaveClass(/active-1/);
    const b = await startBob(a.page);
    await b.app.locator("#btn-pvp").click();
    await relay(a.page, b.page, ALICE);
    // Roles are sorted by address once both are known: Alice may turn out to be player 2.
    await expect(b.app.locator("#line-0-0-h")).toHaveClass(/active-[12]/);
    // Bob's turn now: his line goes back to Alice.
    await b.app.locator("#line-1-1-v").click();
    await expect.poll(async () => (await updates(b.page)).length).toBeGreaterThan(0);
    await relay(b.page, a.page, BOB);
    await expect(a.app.locator("#line-1-1-v")).toHaveClass(/active-[12]/);
});

test("r10s-tower-builder", async ({ browser }) => {
    test.setTimeout(120_000);
    const a = await start(browser, "r10s-tower-builder");
    await a.page.waitForTimeout(1500);
    const box = (await stage(a.page).boundingBox())!;
    // START button, then drop a few blocks.
    await a.page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.88);
    await a.page.waitForTimeout(1500);
    const r = await reacts(a.page, stage(a.page), async () => {
        for (let i = 0; i < 3; i++) {
            await a.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await a.page.waitForTimeout(700);
        }
    });
    const state = (await a.frame.evaluate("({ started: !!gameStart, score: score, floors: successCount })")) as { started: boolean; score: number; floors: number };
    console.log(`[tower-builder] ${JSON.stringify(r)} ${JSON.stringify(state)}`);
    expect(state.started).toBe(true);
    expect(r.changed).toBe(true);
    // Keep dropping until three blocks miss: game over sends the highscore.
    for (let i = 0; i < 80 && !(await updates(a.page)).length; i++) {
        await a.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await a.page.waitForTimeout(250);
    }
    const sent = await updates(a.page);
    expect(sent.length).toBeGreaterThan(0);
    console.log(`[tower-builder] highscore update ${JSON.stringify(sent[0].content).slice(0, 200)}`);
    // "Play again" (where the drops land) reloads the page with ?s=…: it comes back with the list.
    await a.page.waitForTimeout(1500);
    if (await a.app.locator(".js-reload").isVisible()) await a.app.locator(".js-reload").click();
    await expect.poll(() => appFrame(a.page).then((f) => f.url())).toContain("?s=");
    await expect(a.app.locator("#highscorelist")).toContainText("Alice", { timeout: 15_000 });
    const b = await startBob(a.page);
    await relay(a.page, b.page, ALICE);
    await expect(b.app.locator("#highscorelist")).toContainText("Alice");
});

// ---------------------------------------------------------------- tools

test("arcanecircle-draw", async ({ browser }) => {
    const a = await start(browser, "arcanecircle-draw");
    const canvas = a.app.locator("canvas.drawing-board-canvas");
    const blank = await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL());
    const box = (await canvas.boundingBox())!;
    await a.page.mouse.move(box.x + 50, box.y + 50);
    await a.page.mouse.down();
    await a.page.mouse.move(box.x + 250, box.y + 200, { steps: 15 });
    await a.page.mouse.up();
    await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL())).not.toBe(blank);
});

test("arcanecircle-ruffle", async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await start(browser, "arcanecircle-ruffle");
    // A minimal SWF 6 movie: header, 1 frame, ShowFrame, End.
    const body = Buffer.from([0x78, 0x00, 0x05, 0x5f, 0x00, 0x00, 0x0f, 0xa0, 0x00, 0x00, 0x0c, 0x01, 0x00, 0x40, 0x00, 0x00, 0x00]);
    const swf = Buffer.concat([Buffer.from("FWS"), Buffer.from([6]), Buffer.alloc(4), body]);
    swf.writeUInt32LE(swf.length, 4);
    const chooser = a.page.waitForEvent("filechooser");
    await a.app.getByRole("button", { name: "Open File" }).click();
    await (await chooser).setFiles({ name: "empty.swf", mimeType: "application/x-shockwave-flash", buffer: swf });
    await a.page.waitForTimeout(3000);
    const state = await a.frame.evaluate(() => ({ player: !!document.querySelector("ruffle-player, ruffle-object, ruffle-embed"), text: document.body.innerText.slice(0, 200) }));
    console.log(`[ruffle] ${JSON.stringify(state)} updates ${(await updates(a.page)).length}`);
    expect(state.player).toBe(true);
    // The movie travels as an update (a data: URL): Bob gets the same player.
    const b = await startBob(a.page);
    await relay(a.page, b.page, ALICE);
    await expect.poll(() => b.frame.evaluate(() => !!document.querySelector("ruffle-player, ruffle-object, ruffle-embed"))).toBe(true);
});

test("davidsm10-docs-browser", async ({ browser }) => {
    // No webxdc.js in its index.html: same "Starting…" overlay as AmazingTrack.
    const a = await start(browser, "davidsm10-docs-browser", false);
    await expect.poll(() => a.frame.evaluate(() => document.querySelectorAll("button.entry").length), { timeout: 20_000 }).toBeGreaterThan(0);
    await a.page.waitForTimeout(3000);
    const hidden = await covered(a.page);
    console.log(`[docs-browser] overlay visible: ${hidden}`);
    // Under the overlay the app works: open the webxdc docs by script.
    await a.frame.evaluate(() => (Array.from(document.querySelectorAll("button.entry")).find((b) => b.textContent?.includes("webxdc")) as HTMLElement).click());
    await a.page.waitForTimeout(4000);
    const text = await a.frame.evaluate(() => document.body.innerText.slice(0, 300));
    console.log(`[docs-browser] after opening webxdc docs: ${JSON.stringify(text)}`);
    expect(hidden, "the app is hidden behind the widget's Starting… overlay").toBe(false);
});

test("durian-moments", async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await start(browser, "durian-moments");
    await a.app.locator("textarea").fill("Hello from Alice's moment");
    await a.app.locator("#post").click();
    await expect(a.app.locator("main")).toContainText("Hello from Alice's moment");
    await expect.poll(async () => (await updates(a.page)).length).toBeGreaterThan(0);
    const b = await startBob(a.page);
    await relay(a.page, b.page, ALICE);
    await expect(b.app.locator("main")).toContainText("Hello from Alice's moment");
});

test("durian-todolist", async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await start(browser, "durian-todolist");
    await a.app.locator("#AppCreateField").fill("Buy milk");
    await a.app.locator(".AppCreateButton").click();
    await expect(a.app.locator("#AppList")).toContainText("Buy milk");
    await expect.poll(async () => (await updates(a.page)).length).toBeGreaterThan(0);
    const b = await startBob(a.page);
    const seen = await relay(a.page, b.page, ALICE);
    await expect(b.app.locator("#AppList")).toContainText("Buy milk");
    await b.app.locator("#AppCreateField").fill("Bake bread");
    await b.app.locator(".AppCreateButton").click();
    await expect.poll(async () => (await updates(b.page)).length).toBeGreaterThan(0);
    await relay(b.page, a.page, BOB);
    await expect(a.app.locator("#AppList")).toContainText("Bake bread");
    void seen;
});

test("freddi301-sondaggio", async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await start(browser, "freddi301-sondaggio");
    await a.app.getByRole("button", { name: /View poll/ }).click();
    await a.page.waitForTimeout(800);
    const title = a.app.locator("input, textarea").first();
    await title.fill("Lunch on Friday?");
    await title.press("Tab");
    await expect.poll(async () => (await updates(a.page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const b = await startBob(a.page);
    await relay(a.page, b.page, ALICE);
    await b.app.getByRole("button", { name: /View poll/ }).click().catch(() => {});
    await expect.poll(() => b.frame.evaluate(() => Array.from(document.querySelectorAll("input, textarea")).some((i) => (i as HTMLInputElement).value.includes("Lunch on Friday?")) || document.body.innerText.includes("Lunch on Friday?"))).toBe(true);
});

test("lil5-myswap", async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await start(browser, "lil5-myswap");
    const register = async (r: Run, name: string, street: string) => {
        const inputs = r.app.locator("input.input");
        await inputs.nth(1).fill(name);
        await inputs.nth(2).fill(street);
        await r.app.getByRole("button", { name: "Register" }).click();
    };
    await register(a, "Alice A.", "Main Street 1");
    await expect(a.app.getByText("Start your own")).toBeVisible();
    // A new swap ("Start your own" → Name → Create).
    await a.app.locator("input").first().fill("Toy swap");
    await a.app.getByRole("button", { name: "Create" }).click();
    await a.page.waitForTimeout(2500); // the Yjs provider batches its updates
    await expect.poll(async () => (await updates(a.page)).length, { timeout: 10_000 }).toBeGreaterThan(0);
    console.log(`[myswap] alice: ${JSON.stringify(await a.frame.evaluate(() => document.body.innerText.slice(0, 300)))}`);
    const b = await startBob(a.page);
    await relay(a.page, b.page, ALICE);
    await register(b, "Bob B.", "Side Street 2");
    await b.page.waitForTimeout(1500);
    console.log(`[myswap] bob: ${JSON.stringify(await b.frame.evaluate(() => document.body.innerText.slice(0, 400)))}`);
    await expect.poll(() => b.frame.evaluate(() => document.body.innerText.includes("Toy swap") || Array.from(document.querySelectorAll("option")).some((o) => o.textContent!.includes("Toy swap")))).toBe(true);
});

test("mestermim-favorite-player", async ({ browser }) => {
    const a = await start(browser, "mestermim-favorite-player");
    await a.app.getByRole("button", { name: "Got it!" }).click();
    const wav = Buffer.alloc(44 + 16000);
    wav.write("RIFF", 0); wav.writeUInt32LE(36 + 16000, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(16000, 40);
    await a.app.locator("#file-input").setInputFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: wav });
    await expect(a.app.getByText("tone", { exact: false }).first()).toBeVisible();
    await a.app.locator("#play-btn").click();
    await a.page.waitForTimeout(800);
    const playing = await a.frame.evaluate(() => Array.from(document.querySelectorAll("audio, video")).map((m) => ({ paused: (m as HTMLMediaElement).paused, src: (m as HTMLMediaElement).src.slice(0, 30) })));
    console.log(`[favorite-player] media ${JSON.stringify(playing)}`);
    // Share sends the app to the chat (sendToChat): the widget asks first.
    await a.app.locator("#share-app-btn").click();
    const dialog = widget(a.page).getByRole("button", { name: "Send" });
    const asked = await dialog.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    if (asked) await dialog.click();
    await a.page.waitForTimeout(1000);
    console.log(`[favorite-player] share asked ${asked}, chat messages ${(await chats(a.page)).length}`);
});

test("r10s-asc-to-vcard", async ({ browser }) => {
    const a = await start(browser, "r10s-asc-to-vcard");
    await a.app.locator("#vcfAddr").fill("bob@example.org");
    await a.app.locator("#vcfName").fill("Bob");
    await a.app.locator("#vcfKey").fill("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQENBFAKE\n-----END PGP PUBLIC KEY BLOCK-----");
    await a.app.locator("#vcfSend").click();
    await widget(a.page).getByRole("button", { name: "Send" }).click();
    await expect.poll(async () => (await chats(a.page)).length).toBeGreaterThan(0);
    const msg = (await chats(a.page))[0];
    console.log(`[asc-to-vcard] chat message ${JSON.stringify(msg.content).slice(0, 300)}`);
});

test("sbkaf-dice-box", async ({ browser }) => {
    const a = await start(browser, "sbkaf-dice-box");
    await a.page.waitForTimeout(5000);
    const loading = await a.frame.evaluate(() => document.getElementById("loadingText")?.innerText ?? "");
    console.log(`[dice-box] loading text: ${JSON.stringify(loading)}`);
    const wasm404 = a.errors.some((e) => /404 .*\/dice-box\/ammo\/ammo\.wasm\.wasm/.test(e));
    expect(wasm404, "the physics worker's /dice-box/ammo/ammo.wasm.wasm is not served").toBe(false);
});

test("webratte-event-countdown", async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await start(browser, "webratte-event-countdown");
    await a.app.locator("#labelTable0").click();
    await a.app.locator("#inputEvent").fill("Party");
    await a.app.locator("#datepicker").fill("2027-06-01");
    await a.app.locator("#btnSave").click();
    await expect.poll(async () => (await updates(a.page)).length).toBeGreaterThan(0);
    await expect(a.app.locator("body")).toContainText("Party");
    const b = await startBob(a.page);
    await relay(a.page, b.page, ALICE);
    await expect(b.app.locator("body")).toContainText("Party");
});

test("webxdc-corkboard", async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await start(browser, "webxdc-corkboard");
    await a.app.locator("#AppCreateField").fill("Pinned by Alice");
    await a.app.locator(".AppCreateButton").click();
    await expect(a.app.locator("#AppItems")).toContainText("Pinned by Alice");
    await expect.poll(async () => (await updates(a.page)).length).toBeGreaterThan(0);
    const b = await startBob(a.page);
    await relay(a.page, b.page, ALICE);
    await expect(b.app.locator("#AppItems")).toContainText("Pinned by Alice");
});

test("wginolas-deltatiddly", async ({ browser }) => {
    test.setTimeout(120_000);
    const a = await start(browser, "wginolas-deltatiddly");
    await a.app.locator('button[title="Create a new tiddler"]').first().click();
    const title = a.app.locator("input.tc-titlebar.tc-edit-texteditor, .tc-tiddler-edit-title input").first();
    await title.fill("Alice Notes");
    // The body editor is a framed textarea inside the wiki page.
    await a.app.locator(".tc-tiddler-edit-frame iframe").first().contentFrame().locator("textarea").fill("Written by Alice");
    await a.app.locator('button[title="Confirm changes to this tiddler"]').first().click();
    await expect(a.app.locator(".tc-tiddler-view-frame").first()).toContainText("Written by Alice");
    await expect.poll(async () => (await updates(a.page)).some((u) => JSON.stringify(u.content).includes("Alice Notes")), { timeout: 15_000 }).toBe(true);
    const b = await startBob(a.page);
    await relay(a.page, b.page, ALICE);
    await b.page.waitForTimeout(1500);
    const found = await b.frame.evaluate(`!!$tw.wiki.getTiddler("Alice Notes") && $tw.wiki.getTiddler("Alice Notes").fields.text`);
    console.log(`[deltatiddly] bob has tiddler: ${JSON.stringify(found)}`);
    expect(found).toBe("Written by Alice");
});
