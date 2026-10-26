/*
 * Deep test, slice 5: one test per catalog app. Each adds the app through the
 * File tab, does one meaningful thing in it and, where the app shares state
 * through webxdc updates or a realtime channel, checks that the change reaches
 * Bob (relay of updates / to-device realtime data). Results go to
 * test/real/all/deep/<id>.json; screenshots to $SHOTS.
 */
import { expect, test, type Frame, type Page } from "@playwright/test";
import { app, host, relay } from "../real";
import { addXdc, ALICE, appFrame, BOB, covered, firstLine, hold, type Log, newResult, overlay, press, pressFrame, relayRealtime, type Result, saveResult, shot, stage, startPeer, toDevice, uncover, updates, watch } from "./lib";

test.describe.configure({ mode: "parallel" });

const at = pressFrame;

/** A press at a point of the app frame in pixels (what the older call sites use). */
async function pressPx(page: Page, x: number, y: number, ms = 120): Promise<void> {
    const box = (await stage(page).boundingBox())!;
    await press(page, stage(page), x / box.width, y / box.height, ms);
}

/**
 * Runs one app: `body` fills in the result; errors in it count as problems. The
 * test fails only when the body throws (the JSON is written either way).
 */
function deep(id: string, defaults: Partial<Result>, body: (ctx: { alice: Page; frame: Frame; r: Result; log: Log; peers: Page[] }) => Promise<void>, timeout = 120_000) {
    test(id, async ({ browser }) => {
        test.setTimeout(timeout);
        const r = newResult(id, defaults);
        const alice = await host(browser, ALICE, "Alice");
        const log = watch(alice);
        const peers: Page[] = [];
        let failure: unknown;
        try {
            // The app's page, then up to 15 s for its "Starting…" cover; a cover that stays is noted, not fatal.
            const frame = await addXdc(alice, id, false);
            await expect(overlay(alice)).toHaveCount(0, { timeout: 15_000 }).catch(() => {});
            if (await covered(alice)) r.problems.push("the Player's 'Starting…' cover stays over the app");
            await body({ alice, frame, r, log, peers });
        } catch (err) {
            failure = err;
            r.problems.push(`test: ${firstLine(err)}`);
        } finally {
            await shot(alice, `${id}-alice`);
            for (const [i, p] of peers.entries()) await shot(p, `${id}-bob${i ? i : ""}`);
            if (log.errors.length || log.blocked.length) console.log(`  [${id}] console:`, [...new Set([...log.errors, ...log.blocked])].slice(0, 8));
            saveResult(r);
            for (const p of [alice, ...peers]) await p.context().close().catch(() => {});
        }
        if (failure) throw failure;
    });
}

/** Bob on another device, kept in `peers`; a cover that stays over his app is tolerated as for Alice. */
async function bobOf(alice: Page, peers: Page[]): Promise<Page> {
    const { page: bob } = await startPeer(alice, BOB, "Bob", false);
    await expect(overlay(bob)).toHaveCount(0, { timeout: 15_000 }).catch(() => {});
    peers.push(bob);
    return bob;
}

const nUpdates = async (page: Page): Promise<number> => (await updates(page)).length;
const nToDevice = async (page: Page): Promise<number> => (await toDevice(page)).length;

/** Alice does `act`, the update reaches Bob, and `check` sees it there. */
async function shared(alice: Page, peers: Page[], r: Result, check: (bob: Page) => Promise<void>): Promise<Page> {
    await expect.poll(() => nUpdates(alice), { timeout: 15_000 }).toBeGreaterThan(0);
    const bob = await bobOf(alice, peers);
    await relay(alice, bob, ALICE);
    await check(bob);
    r.sync_verified = true;
    return bob;
}

// ---------------------------------------------------------------- lists, notes, planners

deep("hupf-shopping-list", { shared_state: "yes" }, async ({ alice, peers, r }) => {
    r.tested = "Alice adds 'Milk' x2 via Item Name + Add Item; relayed to Bob";
    await app(alice).getByPlaceholder("Item Name").fill("Milk");
    await app(alice).getByRole("button", { name: "Add Item" }).click();
    await expect(app(alice).locator("body")).toContainText("Milk");
    await shared(alice, peers, r, async (bob) => expect(app(bob).locator("body")).toContainText("Milk"));
    r.verdict = "works";
});

deep("simon-event-planner", { shared_state: "yes" }, async ({ alice, peers, r }) => {
    r.tested = "Alice creates a poll 'Team dinner' with one time slot; relayed to Bob";
    await app(alice).getByPlaceholder("Enter event title").fill("Team dinner");
    await app(alice).getByRole("button", { name: /Add Time Slot/ }).click();
    await alice.waitForTimeout(500);
    await app(alice).getByRole("button", { name: "Create Poll" }).click();
    await expect(app(alice).locator("body")).toContainText("Team dinner");
    await shared(alice, peers, r, async (bob) => expect(app(bob).locator("body")).toContainText("Team dinner"));
    r.verdict = "works";
});

deep("webratte-shared-memo", { shared_state: "yes" }, async ({ alice, peers, r }) => {
    r.tested = "Alice types a memo and presses Send Memo; relayed to Bob";
    await app(alice).locator("#input").fill("Remember the milk");
    await app(alice).locator("#updateButton").click();
    await shared(alice, peers, r, async (bob) => expect(app(bob).locator("#input")).toHaveValue("Remember the milk"));
    r.verdict = "works";
});

deep("maphouse-pomodoros", { shared_state: "yes" }, async ({ alice, peers, r }) => {
    r.tested = "Alice presses play (start pomodoro); relayed to Bob, whose timer runs too";
    const before = await app(alice).locator("#btn-start").innerHTML();
    await app(alice).locator("#btn-start").click();
    await expect.poll(() => app(alice).locator("#btn-start").innerHTML()).not.toBe(before);
    await shared(alice, peers, r, async (bob) => expect.poll(() => app(bob).locator("#btn-start").innerHTML()).not.toBe(before));
    r.verdict = "works";
});

deep("ms702-traero", { shared_state: "yes" }, async ({ alice, peers, r }) => {
    r.tested = "Alice adds 'Bread' through 'Something I need...'; relayed to Bob";
    const input = app(alice).locator("#new_item_input");
    await input.fill("Bread");
    await input.press("Enter");
    await expect(app(alice).locator("body")).toContainText("Bread");
    await shared(alice, peers, r, async (bob) => expect(app(bob).locator("body")).toContainText("Bread"));
    r.verdict = "works";
});

/** Dark pixels on a (2D) canvas in the app, to see drawing happen. */
const darkPixels = (frame: Frame, sel = "canvas"): Promise<number> =>
    frame.evaluate((s) => {
        const c = document.querySelector(s) as HTMLCanvasElement;
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 200 && d[i + 3] > 0) n++;
        return n;
    }, sel);

deep("webxdc-pixel", { shared_state: "yes" }, async ({ alice, frame, peers, r }) => {
    r.tested = "Alice draws on the canvas (press at two cells); the pixel update reaches Bob's canvas";
    const before = await darkPixels(frame, "#mycanvas");
    await at(alice, 0.3, 0.3);
    await at(alice, 0.5, 0.5);
    await expect.poll(() => darkPixels(frame, "#mycanvas")).toBeGreaterThan(before);
    const bob = await shared(alice, peers, r, async () => {});
    const bobFrame = await appFrame(bob);
    await expect.poll(() => darkPixels(bobFrame, "#mycanvas")).toBeGreaterThan(before);
    r.notes = "also joins a realtime channel; the persistent pixel updates were verified";
    r.verdict = "works";
});

deep("davidsm10-sharer", { shared_state: "yes" }, async ({ alice, peers, r }) => {
    r.tested = "Alice shares a small text file through the file input; info+part updates relayed to Bob, who sees the file";
    await app(alice).locator("button").first().click(); // "+": the send form
    await app(alice).locator('input[type="file"]').setInputFiles({ name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("hello from alice\n") });
    await app(alice).getByRole("button", { name: "Send File" }).click();
    await alice.waitForTimeout(2500); // parts go out one per second
    await shared(alice, peers, r, async (bob) => expect(app(bob).locator("body")).toContainText("hello.txt"));
    r.verdict = "works";
});

/** Both open at once, as realtime needs; Alice's realtime data (to-device) is delivered to Bob. */
const together = bobOf;

deep("durian-realtime-editor", { shared_state: "realtime" }, async ({ alice, peers, r }) => {
    r.tested = "Alice and Bob open the doc; Alice types; realtime data and the saved update reach Bob's editor";
    const bob = await together(alice, peers);
    await app(alice).locator(".ProseMirror").click();
    await alice.keyboard.type("Hello from Alice");
    await expect(app(alice).locator(".ProseMirror")).toContainText("Hello from Alice");
    await expect.poll(() => nToDevice(alice), { timeout: 10_000 }).toBeGreaterThan(0);
    await relayRealtime(alice, bob, ALICE);
    const live = await app(bob).locator(".ProseMirror").innerText().then((t) => t.includes("Hello from Alice"));
    // The persistent copy: an update once the app saves.
    await expect.poll(() => nUpdates(alice), { timeout: 30_000 }).toBeGreaterThan(0);
    await relay(alice, bob, ALICE);
    await expect(app(bob).locator(".ProseMirror")).toContainText("Hello from Alice");
    r.sync_verified = true;
    r.notes = live ? "text arrived over the realtime channel before the update" : "realtime data did not show the text at once; the saved update did";
    r.verdict = "works";
});

deep("arcanecircle-livechat", { shared_state: "realtime" }, async ({ alice, peers, r }) => {
    r.tested = "Alice and Bob open the chat; Alice sends a message; realtime data relayed to Bob";
    const bob = await together(alice, peers);
    const input = app(alice).locator("input.native-input");
    await input.fill("hi bob");
    await input.press("Enter");
    await expect(app(alice).locator("body")).toContainText("hi bob");
    await expect.poll(() => nToDevice(alice), { timeout: 10_000 }).toBeGreaterThan(0);
    await relayRealtime(alice, bob, ALICE);
    await expect(app(bob).locator("body")).toContainText("hi bob");
    r.sync_verified = true;
    r.verdict = "works";
});

deep("realtime-chat", { shared_state: "realtime" }, async ({ alice, peers, r }) => {
    r.tested = "Alice and Bob open the chat; Alice sends a message; realtime data (and updates) relayed to Bob";
    const bob = await together(alice, peers);
    const input = app(alice).locator("textarea");
    await input.fill("hi bob");
    await input.press("Enter");
    await expect(app(alice).locator("body")).toContainText("hi bob");
    await alice.waitForTimeout(1500);
    await relayRealtime(alice, bob, ALICE);
    await relay(alice, bob, ALICE);
    await expect(app(bob).locator("body")).toContainText("hi bob", { timeout: 15_000 });
    r.sync_verified = true;
    r.verdict = "works";
});

deep("experintellia-halvsies", { shared_state: "yes" }, async ({ alice, peers, r }) => {
    r.tested = "Alice starts the split, adds expense 'Dinner' $42 and saves; relayed to Bob";
    await app(alice).getByRole("button", { name: "Start without a name" }).click();
    await app(alice).getByRole("button", { name: "Add expense" }).click();
    await app(alice).locator("input.amount-input").fill("42");
    await app(alice).getByPlaceholder("e.g. Dinner").fill("Dinner");
    await app(alice).getByRole("button", { name: "Save" }).click();
    await expect(app(alice).locator("body")).toContainText("Dinner");
    await shared(alice, peers, r, async (bob) => expect(app(bob).locator("body")).toContainText("Dinner"));
    r.verdict = "works";
});

// ---------------------------------------------------------------- pixel measures on screenshots

type Clip = { x: number; y: number; width: number; height: number };
const STAGE: Clip = { x: 0, y: 50, width: 900, height: 710 };
/** A screenshot of `clip` of the host page, as base64 (for the pixel measures below). */
const snap = async (page: Page, clip: Clip = STAGE): Promise<string> => (await page.screenshot({ clip })).toString("base64");

/** Share of pixels that differ between two screenshots (decoded in the host page). */
const diff = (page: Page, a: string, b: string): Promise<number> =>
    page.evaluate(async ([a, b]) => {
        const load = async (s: string) => {
            const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
            const c = new OffscreenCanvas(img.width, img.height);
            const g = c.getContext("2d")!;
            g.drawImage(img, 0, 0);
            return g.getImageData(0, 0, img.width, img.height).data;
        };
        const [x, y] = [await load(a), await load(b)];
        let n = 0;
        for (let i = 0; i < x.length; i += 4) if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 48) n++;
        return n / (x.length / 4);
    }, [a, b]);

/** Share of dark pixels in a screenshot (e.g. a dark sprite on a light scene). */
const darkShare = (page: Page, a: string): Promise<number> =>
    page.evaluate(async (a) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${a}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 250) n++;
        return n / (d.length / 4);
    }, a);

/** Share of strongly red pixels in a screenshot. */
const redShare = (page: Page, a: string): Promise<number> =>
    page.evaluate(async (a) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${a}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, img.width, img.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 140 && d[i + 1] < 90 && d[i + 2] < 90) n++;
        return n / (d.length / 4);
    }, a);

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Whether the screen (or `clip` of it) changes because of `input`, beyond its
 * own animation: four idle looks set how much it changes by itself; the look
 * after the input must differ from every idle look by clearly more. (Unlike
 * lib's `reacts`, this measures the share of changed pixels, so a game that
 * animates by itself still has to react to count.)
 */
async function reactsBeyondIdle(page: Page, input: () => Promise<void>, settle = 800, clip: Clip = STAGE): Promise<{ idle: number; input: number; yes: boolean }> {
    const idle: string[] = [];
    for (let i = 0; i < 4; i++) {
        idle.push(await snap(page, clip));
        await page.waitForTimeout(250);
    }
    await input();
    await page.waitForTimeout(settle);
    const after = await snap(page, clip);
    let still = 0;
    for (const x of idle.slice(1)) still = Math.max(still, await diff(page, idle[0], x));
    let moved = 1;
    for (const x of idle) moved = Math.min(moved, await diff(page, x, after));
    return { idle: r3(still), input: r3(moved), yes: moved > Math.max(0.01, still * 1.5 + 0.01) };
}

// ---------------------------------------------------------------- games and tools

/** Games that only share a high score (webxdc-score) at game over. */
const SCORE = "high scores only (webxdc-score), sent at game over";

/** A game input that should change the screen well beyond its own animation. */
async function game(alice: Page, r: Result, what: string, input: () => Promise<void>, settle = 800, clip: Clip = STAGE): Promise<void> {
    const seen = await reactsBeyondIdle(alice, input, settle, clip);
    r.notes = [r.notes, `screen change idle ${seen.idle}, after input ${seen.input}`].filter(Boolean).join("; ");
    if (!seen.yes) throw new Error(`no visible reaction to ${what} (${JSON.stringify(seen)})`);
}

deep("arcanecircle-audiodash", { shared_state: "no" }, async ({ alice, frame, r }) => {
    r.tested = "taps START on the canvas: the game leaves the menu for 'Tap or Hold'; then holds to steer";
    const scene = () => frame.evaluate(`[...document.querySelectorAll("#uiScenes > div:not([hidden])")].map((d) => d.textContent).join(" | ")`) as Promise<string>;
    await expect.poll(scene, { timeout: 60_000 }).toContain("START");
    await at(alice, 0.5, 0.5, 150);
    await expect.poll(scene).toMatch(/Tap or Hold/i);
    await at(alice, 0.5, 0.5, 150); // the tutorial waits for a first tap
    // Steer (hold = up, release = down) for a second of song; unsteered the ship crashes at once.
    const box = (await stage(alice).boundingBox())!;
    await alice.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    let down = false;
    let t = 0;
    for (let i = 0; i < 200; i++) {
        const g = (await frame.evaluate("({ y: ship.y, mid, time: audio.currentTime, over: gameOverScene.active || winScene.active })")) as { y: number; mid: number; time: number; over: boolean };
        t = g.time;
        if (g.over || t >= 1) break;
        if (g.y > g.mid && !down) await alice.mouse.down();
        if (g.y <= g.mid && down) await alice.mouse.up();
        down = g.y > g.mid;
        await alice.waitForTimeout(30);
    }
    if (down) await alice.mouse.up();
    r.notes = `song played ${t.toFixed(2)} s while steering`;
    if (!(t > 0.2)) throw new Error("the song did not play");
    r.verdict = "works";
});

deep("arcanecircle-balance", { shared_state: "no" }, async ({ alice, frame, r }) => {
    r.tested = "app starts? (no webxdc.js in index.html); with the cover hidden, clicks the canvas";
    const cover = await covered(alice);
    const canvases = await frame.evaluate(() => document.querySelectorAll("canvas").length);
    await uncover(alice);
    await alice.waitForTimeout(1000);
    await game(alice, r, "click on the canvas", async () => { await at(alice, 0.5, 0.5); await at(alice, 0.5, 0.7); }, 1200);
    r.notes = `${canvases} canvas(es); ${r.notes}`;
    if (cover) {
        r.verdict = "broken";
        r.cause = "widget";
        r.problems.push("the app never loads webxdc.js, so runner/shim.js never sends {xdc:'hello'}; src/bridge.ts only calls onStatus('running') on hello, and src/Player.svelte keeps the opaque .overlay ('Starting Work-Life Balance…') over a running app forever");
        r.notes += "; the game runs and reacts underneath the cover (seen with the cover hidden). Delta Chat shows such apps normally";
    } else r.verdict = "works";
});

deep("arcanecircle-casual-crusade", { shared_state: "yes" }, async ({ alice, r }) => {
    r.tested = "clicks PLAY on the title screen; the board appears";
    await game(alice, r, "PLAY", () => pressPx(alice, 450, 590));
    r.notes = `${SCORE}; not reached. ${r.notes}`;
    r.verdict = "works";
});

deep("arcanecircle-crashdown", { shared_state: "yes" }, async ({ alice, frame, peers, r }) => {
    r.tested = "clicks groups of blocks (points go up), then lets the blocks reach the top: the game-over score goes out as an update and is in Bob's high scores";
    for (let round = 0; round < 6 && !((await frame.evaluate("total")) as number); round++) {
        for (const y of [668, 622]) for (const x of [280, 325, 370, 420, 465, 510, 560, 605]) await pressPx(alice, x, y, 40);
    }
    const points = (await frame.evaluate("total")) as number;
    if (!(points > 0)) throw new Error("no points after clicking blocks");
    // Nobody plays: the stack reaches the top, the game ends and webxdc-score sends the score.
    await expect.poll(() => frame.evaluate(() => document.getElementById("gow")?.getAttribute("display")), { timeout: 120_000, intervals: [2000] }).not.toBe("none");
    // Bob's copy of webxdc-score has Alice's score.
    await shared(alice, peers, r, async (bob) => {
        const f = await appFrame(bob);
        await expect.poll(() => f.evaluate("JSON.stringify(window.highscores.getHighScores())"), { timeout: 10_000 }).toContain("Alice");
    });
    r.notes = [r.notes, `${points} points from clicks; game over reached`].filter(Boolean).join("; ");
    r.verdict = "works";
}, 200_000);

deep("arcanecircle-justgostraight", { shared_state: "yes" }, async ({ alice, r }) => {
    r.tested = "holds ArrowRight on the beach: the pirate walks";
    await at(alice, 0.5, 0.9);
    await game(alice, r, "ArrowRight", () => hold(alice, "ArrowRight", 800), 600, { x: 440, y: 400, width: 340, height: 130 });
    r.notes = `${SCORE}; not reached. ${r.notes}`;
    r.verdict = "works";
});

deep("arcanecircle-necroticcommander", { shared_state: "yes" }, async ({ alice, r }) => {
    r.tested = "clicks 'Guided Mode' on the menu; the game starts";
    await game(alice, r, "Guided Mode", () => pressPx(alice, 450, 330));
    r.notes = `${SCORE}; not reached. ${r.notes}`;
    r.verdict = "works";
});

deep("arcanecircle-ricochlime", { shared_state: "yes" }, async ({ alice, r, log }) => {
    r.tested = "clicks PLAY on the Flutter menu; the game screen appears";
    await game(alice, r, "PLAY", () => pressPx(alice, 450, 268), 1500);
    if (log.blocked.some((b) => /fonts\.gstatic\.com/.test(b))) {
        r.problems.push("fetches the Roboto font from fonts.gstatic.com, blocked by CSP connect-src (Flutter's default font fallback)");
        r.cause = "app";
    }
    r.notes = `${SCORE} (highscores.js); not reached. ${r.notes}`;
    r.verdict = "works";
});

deep("arcanecircle-stolen-sword", { shared_state: "yes" }, async ({ alice, r }) => {
    r.tested = "clicks on the title; the ninja appears and the level starts";
    // The ninja (dark) runs in over the light, misty scene.
    const scene: Clip = { x: 210, y: 300, width: 480, height: 440 };
    const before = await darkShare(alice, await snap(alice, scene));
    // The title takes clicks only after its intro: click until the ninja is there.
    await expect(async () => {
        await at(alice, 0.5, 0.6);
        await alice.waitForTimeout(1200);
        expect(await darkShare(alice, await snap(alice, scene))).toBeGreaterThan(before + 0.003);
    }).toPass({ timeout: 20_000 });
    r.notes = `dark share before ${r3(before)}, after ${r3(await darkShare(alice, await snap(alice, scene)))}`;
    r.notes = `sends level/win scores at level end; not reached. ${r.notes}`;
    r.verdict = "works";
});

deep("arcanecircle-templarsfinalstand", { shared_state: "yes" }, async ({ alice, r }) => {
    r.tested = "taps 'Tap to start'; the battle starts";
    await game(alice, r, "tap", () => pressPx(alice, 450, 560));
    r.notes = `${SCORE}; not reached. ${r.notes}`;
    r.verdict = "works";
});

deep("arcanecircle-triska", { shared_state: "yes" }, async ({ alice, r }) => {
    r.tested = "clicks PLAY; the game starts";
    // The red PLAY banner goes away when the game starts (the title itself is animated).
    const banner: Clip = { x: 330, y: 420, width: 240, height: 80 };
    const red = async () => redShare(alice, await snap(alice, banner));
    await expect.poll(red, { timeout: 15_000 }).toBeGreaterThan(0.3);
    await expect(async () => {
        await pressPx(alice, 450, 411);
        await alice.waitForTimeout(1000);
        expect(await red()).toBeLessThan(0.05);
    }).toPass({ timeout: 20_000 });
    r.notes = `${SCORE}; not reached. ${r.notes}`;
    r.verdict = "works";
});

deep("arcanecircle-tic80", { shared_state: "no" }, async ({ alice, r, log }) => {
    r.tested = "types 'help' + Enter in the TIC-80 console; the help text appears";
    await alice.waitForTimeout(4000); // boot animation
    await at(alice, 0.5, 0.5);
    await game(alice, r, "typing help", async () => { await alice.keyboard.type("help", { delay: 60 }); await alice.keyboard.press("Enter"); }, 1200);
    if (log.errors.some((e) => /^HTTP 404 .*\/json\?fn=version/.test(e))) r.notes += "; a 404 for /json?fn=version (TIC-80 asks its website for updates; no network in webxdc either) and an 'unwind' pageerror (Emscripten's normal main-loop exit)";
    r.verdict = "works";
});

deep("zalexanninev15-kojios", { shared_state: "no" }, async ({ alice, frame, r, log }) => {
    r.tested = "app starts? (no webxdc.js); with the cover hidden, types 'help' + Enter in the terminal";
    const cover = await covered(alice);
    await uncover(alice);
    await app(alice).locator("body").click();
    const before = await frame.evaluate(() => document.body.innerText.length);
    await alice.keyboard.type("help", { delay: 40 });
    await alice.keyboard.press("Enter");
    await alice.waitForTimeout(1000);
    const after = await frame.evaluate(() => document.body.innerText.length);
    const missing = log.errors.filter((e) => /^HTTP 404 /.test(e));
    r.problems.push(`index.html loads ./jsmediatags.min.js, ./heic2any.min.js etc. but the .xdc has them under scripts/: ${missing.length} x 404`);
    if (log.blocked.length) r.problems.push("loads pyodide from cdn.jsdelivr.net, blocked by CSP (needs the internet)");
    r.notes = `terminal text ${before} -> ${after} chars after 'help'`;
    if (cover) {
        r.problems.push("no webxdc.js in index.html: the Player's opaque 'Starting KojiOS…' cover never goes away (src/bridge.ts sets running only on the shim's hello)");
        r.cause = "widget";
    } else r.cause = "app";
    r.verdict = after > before ? (cover ? "broken" : "partial") : "broken";
});

deep("experintellia-data-dealer", { shared_state: "yes" }, async ({ alice, frame, peers, r, log }) => {
    r.tested = "taps through Marco's intro; Alice's join updates relayed to Bob, whose Leaderboard lists Alice";
    const text = () => frame.evaluate(() => document.body.innerText);
    await expect.poll(text, { timeout: 20_000 }).toContain("Marco");
    const before = await text();
    await at(alice, 0.5, 0.6);
    await expect.poll(text).not.toBe(before);
    const bob = await shared(alice, peers, r, async () => {});
    r.sync_verified = false;
    await app(bob).getByText(/Leaderboard/i).first().click({ timeout: 10_000 }).catch(() => {});
    await bob.waitForTimeout(1500);
    await expect(app(bob).locator("body")).toContainText("Alice", { timeout: 10_000 });
    r.sync_verified = true;
    if (log.errors.some((e) => /^HTTP 404 .*__webxdc__\/avatar\//.test(e))) r.notes = "asks for __webxdc__/avatar/<hash>.jpg (not part of the webxdc API, 404 here); the app falls back to its default picture";
    r.verdict = "works";
});

deep("arcanecircle-babeldungeon-it-en", { shared_state: "yes" }, async ({ alice, frame, peers, r }) => {
    r.tested = "New Game, English, play a round; the game state (updates keyed by selfAddr) reaches Alice's second device";
    await app(alice).getByRole("button", { name: "New Game" }).click();
    await app(alice).getByRole("button", { name: "English" }).click();
    await expect(app(alice).locator("body")).toContainText("LEVEL");
    const before = await frame.evaluate(() => document.body.innerText);
    await app(alice).locator("button").last().click(); // the big play button
    await expect.poll(() => frame.evaluate(() => document.body.innerText)).not.toBe(before);
    await expect.poll(() => nUpdates(alice), { timeout: 15_000 }).toBeGreaterThan(0);
    // The state is per player: Alice on another device should continue, not get the New Game menu.
    const { page: again } = await startPeer(alice, ALICE, "Alice", false);
    peers.push(again);
    await relay(alice, again, ALICE);
    await expect(app(again).locator("body")).toContainText("LEVEL", { timeout: 15_000 });
    r.sync_verified = true;
    r.notes = "state is per player (uid = selfAddr), synced between one person's devices; Bob sees nothing of it";
    r.verdict = "works";
});

deep("pea-webxdcfishing", { shared_state: "realtime" }, async ({ alice, peers, r }) => {
    r.tested = "Alice and Bob in the world; Alice sends a chat line (realtime); relayed to Bob's chatbox";
    const bob = await together(alice, peers);
    await alice.waitForTimeout(2000);
    // As in a real room: Bob's "join" reaches Alice, who answers with her state; then Bob knows her.
    await bob.waitForTimeout(5000); // Bob's player is created once the world has loaded
    let back = 0;
    let seen = 0;
    await expect(async () => {
        back = await relayRealtime(bob, alice, BOB, back);
        await alice.waitForTimeout(500);
        seen = await relayRealtime(alice, bob, ALICE, seen);
        await bob.waitForTimeout(1500);
        expect(await nToDevice(bob)).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });
    await bob.waitForTimeout(2000); // Bob loads Alice's character model; chat from unknown players is dropped
    const input = app(alice).locator("#chatbox-input");
    await input.fill("hi bob");
    await input.press("Enter");
    await expect(app(alice).locator("#chatbox-output")).toContainText("hi bob");
    await expect.poll(() => nToDevice(alice), { timeout: 10_000 }).toBeGreaterThan(seen);
    seen = await relayRealtime(alice, bob, ALICE, seen);
    await expect(app(bob).locator("#chatbox-output")).toContainText("hi bob", { timeout: 10_000 });
    r.sync_verified = true;
    r.notes = "also saves progress as webxdc updates";
    r.verdict = "works";
});

deep("webxdc-pong", { shared_state: "realtime" }, async ({ alice, peers, r }) => {
    r.tested = "Alice and Bob open Pong; realtime data relayed both ways; Bob's screen changes (second paddle/RTT)";
    // A paddle is free once nobody was seen on it for 1.5 s since the page loaded.
    await alice.waitForTimeout(2500);
    const bob = await together(alice, peers);
    const before = await snap(bob);
    // Alice moves her paddle (it follows the pointer).
    const box = (await stage(alice).boundingBox())!;
    await alice.mouse.move(box.x + 450, box.y + 600);
    await alice.mouse.down();
    await alice.mouse.move(box.x + 350, box.y + 600, { steps: 8 });
    await alice.mouse.move(box.x + 550, box.y + 600, { steps: 8 });
    await alice.mouse.up();
    let a = 0;
    let b = 0;
    for (let i = 0; i < 6; i++) {
        a = await relayRealtime(alice, bob, ALICE, a);
        b = await relayRealtime(bob, alice, BOB, b);
        await alice.waitForTimeout(300);
    }
    if (a === 0) throw new Error("Alice sent no realtime data");
    const changed = await diff(bob, before, await snap(bob));
    r.notes = `realtime messages Alice ${a}, Bob ${b}; Bob's screen changed ${changed.toFixed(3)}`;
    if (changed < 0.001) throw new Error("Bob's screen did not change after realtime data");
    r.sync_verified = true;
    r.verdict = "works";
});
