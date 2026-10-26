/*
 * Deep test, slice 6: one meaningful interaction per catalog app, and for apps
 * that share state, the change travelling to Bob through relay(). Results and
 * verdicts are in test/real/all/deep/<id>.json and slice-6.md.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Frame, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { app, host, relay, widget, type W } from "../real";
import { addXdc, ALICE, appFrame, appFrameAny, BOB, chats, drag, overlay, press, reacts, relayRealtime, SHOTS, shot, startPeer, toDevice, uncover, updates, watch } from "./lib";

const ids = readFileSync("test/real/all/deep/slice-6.txt", "utf8").split("\n").filter(Boolean);
const pick = process.env.APPS?.split(",");
test.describe.configure({ mode: "parallel" });

type Ctx = { alice: Page; f: Frame; a: FrameLocator; errors: string[] };

/** How many updates the widget sent. */
const nUpdates = async (p: Page): Promise<number> => (await updates(p)).length;

const tests: Record<string, (c: Ctx) => Promise<void>> = {
    "arcanecircle-chess": async ({ alice, a }) => {
        await a.getByText("Start Game").click();
        await expect(a.getByText("Waiting for opponent")).toBeVisible();
        expect(await nUpdates(alice)).toBeGreaterThan(0);
        const { page: bob, app: b } = await startPeer(alice);
        await relay(alice, bob, ALICE);
        await expect(b.getByText("Join Game")).toBeVisible();
        await b.getByText("Join Game").click();
        await expect.poll(() => nUpdates(bob)).toBeGreaterThan(0);
        await relay(bob, alice, BOB);
        // Alice (white) gets the board once Bob's join request arrives.
        await expect(a.locator(".square-e2")).toBeVisible({ timeout: 15_000 });
        await a.locator(".square-e2 img").dragTo(a.locator(".square-e4"));
        await expect(a.locator(".square-e4 img")).toBeVisible();
        await expect.poll(async () => (await updates(alice)).some((u) => JSON.stringify(u.content).includes("e4"))).toBe(true);
        await relay(alice, bob, ALICE, 0);
        await expect(b.locator(".square-e4 img")).toBeVisible();
    },

    "arcanecircle-whack-a-ninja": async ({ alice, a }) => {
        await a.locator("#toggle").click();
        await expect(a.locator("#toggle")).toHaveText("Surrender");
        const score = async () => parseInt((await a.locator("#score").textContent()) ?? "0") || 0;
        for (let i = 0; i < 40 && (await score()) < 2; i++) {
            const n = a.locator(".square.ninja");
            if (await n.count()) await n.first().dispatchEvent("pointerdown").catch(() => {});
            await alice.waitForTimeout(150);
        }
        expect(await score()).toBeGreaterThan(0);
        await a.locator("#toggle").click(); // surrender: the score goes to the scoreboard
        await expect(a.locator("#gameover")).toContainText("You scored");
        await expect.poll(() => nUpdates(alice)).toBeGreaterThan(0);
        const { page: bob, app: b } = await startPeer(alice);
        await relay(alice, bob, ALICE);
        await b.locator("#score-btn").click();
        await expect(b.locator("#scoreboard-container")).toContainText("Alice");
    },

    "grzgrz-fundit": async ({ alice, a }) => {
        await a.getByRole("button", { name: "Join Game" }).click();
        await expect(a.getByText(/Players \(1\/4\)/)).toBeVisible();
        await expect.poll(() => nUpdates(alice)).toBeGreaterThan(0);
        const { page: bob, app: b } = await startPeer(alice);
        await relay(alice, bob, ALICE);
        await expect(b.getByText(/Players \(1\/4\)/)).toBeVisible({ timeout: 15_000 });
        await expect(b.getByText("Alice").first()).toBeVisible();
    },

    "experintellia-md-docs": async ({ alice, a, f }) => {
        await a.locator("#editor [contenteditable=true]").first().click();
        await alice.keyboard.press("ControlOrMeta+a");
        await alice.keyboard.type("# Hello Bob\n\nshared text");
        await expect.poll(() => nUpdates(alice), { timeout: 20_000 }).toBeGreaterThan(0);
        const { page: bob, app: b } = await startPeer(alice);
        await relay(alice, bob, ALICE);
        await expect(b.locator("#editor")).toContainText("shared text", { timeout: 15_000 });
    },

    "bespinas-conviu": async ({ alice, a }) => {
        await a.getByAltText("Create task").click();
        await a.locator("#name").fill("Water the plants");
        await a.locator("#frequency-amount").fill("2");
        await a.locator("#frequency-unit").selectOption("week");
        await a.getByRole("button", { name: "Create task" }).click();
        await expect(a.getByText("Water the plants")).toBeVisible();
        // The Yjs state follows the "➕" info message by sendUpdateInterval.
        const t0 = Date.now();
        await expect.poll(async () => (await updates(alice)).some((u) => u.content.updates.some((x: any) => Object.keys(x.payload).length)), { timeout: 40_000 }).toBe(true);
        console.log(`conviu state update after ${Date.now() - t0} ms; to-device:`, (await toDevice(alice)).length);
        const { page: bob, app: b } = await startPeer(alice);
        await relay(alice, bob, ALICE);
        await expect(b.getByText("Water the plants")).toBeVisible({ timeout: 15_000 });
    },

    "arcanecircle-babeldungeon-de-es": async (c) => babel(c, "German"),
    "arcanecircle-babeldungeon-jp-en": async (c) => babel(c, /Japanese|English/),

    "arcanecircle-dogspinner": async ({ alice, f }) => {
        // Laid out for a phone: in the 900×760 window the crank is below the frame.
        await alice.setViewportSize({ width: 420, height: 860 });
        await alice.waitForTimeout(2000);
        await shot(alice, "dogspinner-portrait");
        // The crank's knob (the small circle on the arm): hover shows a grab cursor, dragging round spins the dog.
        const cursor = () => f.evaluate(() => document.querySelector("canvas")!.style.cursor);
        let knob: [number, number] | null = null;
        for (let y = 600; y <= 850 && !knob; y += 8)
            for (let x = 200; x <= 410 && !knob; x += 8) {
                await alice.mouse.move(x, y);
                if (/grab|pointer/.test(await cursor())) knob = [x, y];
            }
        console.log("dogspinner: knob at", knob, await cursor());
        expect(knob).not.toBeNull();
        await shot(alice, "dogspinner-before");
        await alice.mouse.down();
        for (let i = 0; i <= 48; i++) {
            const t = (i / 12) * Math.PI * 2;
            await alice.mouse.move(knob![0] + Math.sin(t) * 60, knob![1] - 60 + Math.cos(t) * 60);
            await alice.waitForTimeout(16);
        }
        await shot(alice, "dogspinner-after");
        await alice.mouse.up();
    },

    "arcanecircle-kleptokitty": async ({ alice, a, f }) => {
        await alice.waitForTimeout(1500);
        const c = a.locator("canvas").last();
        expect((await reacts(alice, c, async () => {
            await press(alice, c, 0.5, 0.6);
            await alice.waitForTimeout(1500);
            await alice.keyboard.press("ArrowLeft");
            await alice.keyboard.press("ArrowUp");
        })).changed).toBe(true);
    },

    "arcanecircle-runekeeper": async ({ alice, a }) => {
        await alice.waitForTimeout(1500);
        const c = a.locator("canvas");
        // An up-down stroke on the left pad: the "↕" rune moves the stone.
        expect((await reacts(alice, c, async () => {
            await drag(alice, c, [0.45, 0.75], [0.45, 0.95]);
            await alice.waitForTimeout(300);
            await drag(alice, c, [0.25, 0.8], [0.25, 0.95]);
        })).changed).toBe(true);
        await scoreSync(alice, "runekeeper");
    },

    "arcanecircle-terraformers": async ({ alice, a }) => {
        await alice.waitForTimeout(4000); // "LOADING..." first, then the START screen
        const c = a.locator("canvas");
        expect((await reacts(alice, c, async () => {
            await press(alice, c, 0.5, 0.69); // START
            await alice.waitForTimeout(500);
            await alice.keyboard.down("ArrowRight");
            await alice.waitForTimeout(600);
            await alice.keyboard.up("ArrowRight");
        })).changed).toBe(true);
        await scoreSync(alice, "terraformers");
    },

    "arcanecircle-sub13": async ({ alice, a }) => {
        await alice.waitForTimeout(1500);
        const c = a.locator("canvas");
        expect((await reacts(alice, c, async () => {
            await press(alice, c);
            await alice.keyboard.press("Space");
            await alice.waitForTimeout(500);
            await alice.keyboard.down("ArrowUp");
            await alice.waitForTimeout(600);
            await alice.keyboard.up("ArrowUp");
        })).changed).toBe(true);
        await scoreSync(alice, "sub13");
    },

    "arcanecircle-pixel": async ({ alice, a }) => {
        const c = a.locator("#mycanvas");
        await alice.waitForTimeout(1000);
        const { page: bob, app: b } = await startPeer(alice);
        await bob.waitForTimeout(1000);
        const pixels = () => b.locator("#mycanvas").screenshot();
        const empty = await pixels();
        await drag(alice, c, [0.2, 0.2], [0.6, 0.4]);
        await expect.poll(() => nUpdates(alice)).toBeGreaterThan(0);
        // While drawing, strokes go by realtime (to-device) ...
        const rt = await relayRealtime(alice, bob, ALICE);
        expect(rt).toBeGreaterThan(0);
        await bob.waitForTimeout(800);
        const live = await pixels();
        await shot(bob, "pixel-bob-realtime");
        expect(live.equals(empty), "realtime strokes reach Bob").toBe(false);
        // ... and the finished stroke as an update.
        await relay(alice, bob, ALICE);
        await bob.waitForTimeout(800);
        expect((await pixels()).equals(empty)).toBe(false);
    },

    "rtn-decker": async ({ alice, a, f }) => {
        await alice.waitForTimeout(1000);
        // The tour's "Webxdc" card: a chat over webxdc updates.
        await f.evaluate("n_go([lms('Webxdc')],deck)");
        await alice.waitForTimeout(500);
        const d = a.locator("#display");
        const box = (await d.boundingBox())!;
        await alice.mouse.click(box.x + box.width * (100 / 512), box.y + box.height * (282 / 342));
        await alice.waitForTimeout(300);
        await alice.keyboard.type("hello from decker", { delay: 60 });
        await alice.mouse.click(box.x + box.width * (460 / 512), box.y + box.height * (282 / 342));
        await shot(alice, "decker-sent");
        await expect.poll(() => nUpdates(alice)).toBeGreaterThan(0);
        expect(JSON.stringify(await updates(alice))).toContain("hello from decker");
        const { page: bob, app: b, frame: fb } = await startPeer(alice);
        await bob.waitForTimeout(1000);
        await fb.evaluate("n_go([lms('Webxdc')],deck)");
        await bob.waitForTimeout(500);
        const before = await b.locator("#display").screenshot();
        await relay(alice, bob, ALICE);
        await bob.waitForTimeout(1000);
        await shot(bob, "decker-bob");
        expect(before.equals(await b.locator("#display").screenshot())).toBe(false);
    },

    "image-album": async ({ alice, a, errors }) => {
        const add = async () => {
            const chooser = alice.waitForEvent("filechooser");
            await a.getByRole("button", { name: "Add Image" }).click();
            await (await chooser).setFiles({ name: "red.png", mimeType: "image/png", buffer: PNG });
            await alice.waitForTimeout(3000);
        };
        const shown = () => a.locator("img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth > 0));
        // "no processing": the image goes in as it is.
        const speed = a.locator('input[type="range"]').first();
        await speed.fill(await speed.evaluate((e) => (e as HTMLInputElement).max));
        await add();
        expect(await shown()).toContain(true);
        await a.getByRole("button", { name: "Send" }).click();
        await a.getByRole("button", { name: "Send ZIP File" }).click();
        // The widget asks before the app posts to the chat.
        await expect(widget(alice).getByRole("alertdialog")).toBeVisible();
        console.log("album: toChat dialog:", (await widget(alice).getByRole("alertdialog").textContent())?.replace(/\s+/g, " ").slice(0, 200));
        await widget(alice).getByRole("alertdialog").getByRole("button", { name: "Send" }).click();
        await expect.poll(async () => (await chats(alice)).length).toBe(1);
        // Default speed: AVIF in a module worker started from "/assets/encoder-….js".
        await alice.mouse.click(450, 650); // closes the send panel
        await speed.fill("10");
        await add();
        await shot(alice, "album-encoded");
        console.log("album: errors:", errors.filter((e) => /assets/.test(e)));
        expect((await shown()).filter((x) => !x).length, "the AVIF encoder never finishes").toBe(0);
    },

    "maplediss-quiet-bible-reader": async ({ alice, a, f }) => {
        await a.locator("#foot-next").click();
        await expect(a.locator("#btn-chap")).toHaveText("2");
        // Sync of notes is opt-in, in Settings.
        await f.evaluate("openSettings()");
        await a.locator("#note-sync-toggle").click();
        await alice.waitForTimeout(500);
        await a.getByRole("button", { name: "Enable Sync" }).click();
        await expect(a.locator("#note-sync-status")).toContainText("enabled");
        await a.getByRole("button", { name: "Close" }).last().click();
        await a.getByRole("button", { name: "Add note to verse 1", exact: true }).click();
        await alice.waitForTimeout(500);
        await a.locator("#annotation-note-body").fill("In the beginning: a shared note");
        await a.locator("#annotation-save").click();
        await expect.poll(async () => JSON.stringify(await updates(alice)), { timeout: 20_000 }).toContain("a shared note");
        // Bob, with sync on as well, gets the note.
        const { page: bob, app: b, frame: fb } = await startPeer(alice);
        await fb.evaluate("openSettings()");
        await b.locator("#note-sync-toggle").click();
        await b.getByRole("button", { name: "Enable Sync" }).click();
        await b.getByRole("button", { name: "Close" }).last().click();
        await relay(alice, bob, ALICE);
        await b.locator("#btn-notes").click();
        await expect(b.getByText("a shared note")).toBeVisible({ timeout: 10_000 });
        await shot(alice, "bible-note");
    },

    "ms702-v86emu": async ({ alice, a, f }) => {
        // A floppy whose boot sector prints a line through the BIOS.
        const img = Buffer.alloc(1474560);
        const msg = "HELLO FROM V86";
        const code = [0xbe, 0x00, 0x00, 0xb4, 0x0e]; // mov si, msg; mov ah, 0x0e
        const loop = [0xac, 0x08, 0xc0, 0x74, 0x04, 0xcd, 0x10, 0xeb, 0xf7, 0xeb, 0xfe]; // lodsb; or al,al; jz +4; int 10h; jmp loop; jmp $
        const msgAt = 0x7c00 + code.length + loop.length;
        code[1] = msgAt & 0xff;
        code[2] = msgAt >> 8;
        Buffer.from([...code, ...loop, ...Buffer.from(msg + "\0")]).copy(img, 0);
        img[510] = 0x55;
        img[511] = 0xaa;
        await a.locator("#disk_image").setInputFiles({ name: "hello.img", mimeType: "application/octet-stream", buffer: img });
        await a.locator("#start_bt").click();
        await expect(a.locator("#screen_container")).toContainText(msg, { timeout: 30_000 });
        await shot(alice, "v86");
        console.log("v86 realtime messages:", (await toDevice(alice)).length);
    },

    "wofwca-quake3": async ({ alice, a, errors }) => {
        await a.getByText("Play Open Arena").click();
        // Single player: the bundled Open Arena map loads and renders.
        // (The page reloads itself with ?basegame=baseoa-mini.)
        await expect.poll(() => appFrame(alice).then((g) => g.evaluate(() => (/basegame/.test(location.search) && document.querySelector("canvas")?.width) || 0)).catch(() => 0), { timeout: 30_000 }).toBeGreaterThan(300);
        await alice.waitForTimeout(4000);
        await shot(alice, "quake3");
        // Multiplayer: override-webrtc.js replaces RTCPeerConnection with one over
        // joinRealtimeChannel; runner/shim.js has made it read-only.
        expect(errors.some((e) => /Cannot assign to read only property 'RTCPeerConnection'/.test(e))).toBe(true);
    },

    "arcanecircle-balancefish": async ({ alice, a }) => noWebxdcJs(alice, a, a.locator("canvas").first(), async () => {
        const c = a.locator("canvas").first();
        await alice.waitForTimeout(1500);
        expect((await reacts(alice, c, async () => {
            await press(alice, c, 0.5, 0.4); // "Quick Play"
            await alice.waitForTimeout(1500);
            await press(alice, c, 0.5, 0.5);
        })).changed).toBe(true);
    }),

    "durian-river": async ({ alice, a }) => noWebxdcJs(alice, a, a.locator("canvas").first(), async () => {
        const c = a.locator("canvas").first();
        expect((await reacts(alice, c, async () => {
            await press(alice, c); // "tap to play audio"
            await alice.waitForTimeout(1500);
            await drag(alice, c, [0.3, 0.3], [0.7, 0.6]);
        })).changed).toBe(true);
    }),

    "zalexanninev15-nexttools": async ({ alice, a, f }) => noWebxdcJs(alice, a, a.getByText("UUIDs generator").first(), async () => {
        await alice.waitForTimeout(1500);
        await expect(a.getByText("UUID configuration")).toBeVisible();
        // Next.js routes to "/uuid-generator": out of /app/<key>/ on the runner origin.
        const url = f.url();
        console.log("nexttools url", url, await f.title());
        await shot(alice, "nexttools");
        // A reload of that page then has nothing to serve it.
        await f.evaluate(() => location.reload());
        await alice.waitForTimeout(2000);
        const after = await appFrameAny(alice);
        console.log("nexttools after reload:", after.url(), (await after.evaluate(() => document.body?.innerText ?? "")).slice(0, 120).replace(/\s+/g, " "));
        await shot(alice, "nexttools-reload");
    }),

    "r10s-hextris": async ({ alice, f }) => {
        const state = () => f.evaluate("gameState") as Promise<number>;
        const before = await state();
        await alice.keyboard.press("Space");
        await alice.mouse.click(450, 400);
        await expect.poll(state).not.toBe(before);
        console.log("hextris gameState", before, await state());
        await alice.keyboard.press("ArrowLeft");
        // The highscore list is shared: a score Alice makes reaches Bob.
        await f.evaluate("updateSelfHighscore(7)");
        await expect.poll(() => nUpdates(alice)).toBeGreaterThan(0);
        const { page: bob, frame: fb } = await startPeer(alice);
        await relay(alice, bob, ALICE);
        await expect.poll(() => fb.evaluate("JSON.stringify(getAllHighscores())")).toContain('"name":"Alice","score":7');
    },

    "arcanecircle-numberknight": async ({ alice, a, f }) => noWebxdcJs(alice, a, a.getByRole("button", { name: "Play without sound" }), async () => {
        await expect(a.getByRole("button", { name: "Play without sound" })).toBeHidden();
        await shot(alice, "numberknight");
    }),

    "dc09-dclogin": async ({ alice, a }) => noWebxdcJs(alice, a, a.locator("#generate"), async () => {
        await a.locator("#email").fill("me@example.org");
        await a.locator("#password").fill("secret");
        await a.locator("#generate").click();
        await expect(a.locator("#result-link")).toHaveAttribute("href", /^dclogin:/);
    }),

    "simon-timetracking": async ({ alice, a, f }) => {
        await a.locator("input").first().fill("Write tests");
        await a.getByRole("button", { name: "Start" }).click();
        await expect(a.getByRole("button", { name: "Stop" })).toBeVisible();
        await expect.poll(() => nUpdates(alice)).toBeGreaterThan(0);
        const { page: bob, app: b } = await startPeer(alice);
        await relay(alice, bob, ALICE);
        await expect(b.getByText("Write tests").first()).toBeVisible();
    },

    "webxdc-calc": async ({ alice, a, f }) => {
        await alice.waitForTimeout(1000);
        await a.locator("canvas").first().click({ position: { x: 150, y: 40 } });
        await expect(a.getByRole("button", { name: "B1" })).toBeVisible();
        await alice.keyboard.type("42");
        await alice.keyboard.press("Enter");
        await expect.poll(() => nUpdates(alice)).toBeGreaterThan(0);
        const { page: bob, app: b } = await startPeer(alice);
        await relay(alice, bob, ALICE);
        await bob.waitForTimeout(1000);
        // The formula bar shows the selected cell's content: B1.
        await b.locator("canvas").first().click({ position: { x: 150, y: 40 } });
        await expect(b.getByRole("button", { name: "B1" })).toBeVisible();
        await expect.poll(() => b.locator("textarea").first().inputValue()).toBe("42");
    },

    "webxdc-poll": async ({ alice, a }) => {
        await a.locator("#configureQuestion").fill("Lunch?");
        await a.locator("#configureAnswer0").fill("Pizza");
        await a.locator("#configureAnswer1").fill("Sushi");
        await a.getByText("Create Poll").click();
        await expect(a.getByText("Lunch?").first()).toBeVisible();
        await expect.poll(() => nUpdates(alice)).toBeGreaterThan(0);
        const { page: bob, app: b } = await startPeer(alice);
        await relay(alice, bob, ALICE);
        await expect(b.getByText("Lunch?").first()).toBeVisible();
        await expect(b.getByText("Sushi").first()).toBeVisible();
    },
};

/**
 * An app without webxdc.js: the widget waits for its hello and keeps "Starting…"
 * over the frame, which takes the clicks. The app itself runs underneath:
 * `works` drives it with DOM events.
 */
async function noWebxdcJs(page: Page, a: FrameLocator, target: Locator, works: () => Promise<void>): Promise<void> {
    await page.waitForTimeout(5000);
    await expect(overlay(page)).toBeVisible();
    await expect(overlay(page)).toContainText("Starting");
    const err = await target.click({ timeout: 2000 }).then(() => "", (e: Error) => e.message);
    console.log("click through the overlay:", /intercepts pointer events/.test(err) ? "intercepted by the overlay" : err || "went through");
    if (!err) return; // the overlay let the click through after all
    // Underneath, the app runs: hide the overlay and use it as a person would.
    await uncover(page);
    await target.click();
    await works();
}

/** Babel Dungeon: a language course; each player's progress goes to the room as updates (uid = selfAddr). */
async function babel({ alice, a }: Ctx, lang: string | RegExp): Promise<void> {
    await a.getByRole("button", { name: "New Game" }).click();
    await a.getByRole("button", { name: lang }).first().click();
    await expect(a.getByText("LEVEL")).toBeVisible();
    await expect.poll(() => nUpdates(alice)).toBeGreaterThan(0);
    // Progress is per player (uid = selfAddr) and follows her to her other devices.
    const { page: phone, app: b } = await startPeer(alice, ALICE, "Alice");
    await expect(b.getByRole("button", { name: "New Game" })).toBeVisible();
    await relay(alice, phone, ALICE);
    await expect(b.getByText("LEVEL")).toBeVisible({ timeout: 10_000 });
    await expect(b.getByRole("button", { name: "New Game" })).toBeHidden();
}

/** webxdc-score games: the score list is shared; a score Alice sets reaches Bob's list. */
async function scoreSync(alice: Page, name: string): Promise<void> {
    const f = await appFrame(alice);
    await f.evaluate(() => (window as any).highscores.setScore(1234, true));
    await expect.poll(() => nUpdates(alice)).toBeGreaterThan(0);
    const { page: bob, frame: fb } = await startPeer(alice);
    await relay(alice, bob, ALICE);
    await expect.poll(() => fb.evaluate(() => JSON.stringify((window as any).highscores.getHighScores()))).toContain("1234");
    await shot(bob, `${name}-bob`);
}

/** A 4×4 red PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC", "base64");

for (const id of ids.filter((i) => !pick || pick.includes(i))) {
    test(id, async ({ browser }) => {
        test.setTimeout(120_000);
        const alice = await host(browser, ALICE, "Alice");
        const { errors } = watch(alice);
        const run = tests[id];
        test.skip(!run, "no test yet");
        const f = await addXdc(alice, id, !NO_WEBXDC_JS.includes(id));
        try {
            await run({ alice, f, a: app(alice), errors });
        } finally {
            if (SHOTS) for (const p of alice.context().browser()!.contexts().flatMap((c) => c.pages())) await p.screenshot({ path: `${SHOTS}/${id}-${(await p.evaluate(() => (window as W).__TEST_FIXTURE__?.params?.matrix_display_name)) ?? "x"}.png` }).catch(() => {});
            if (errors.length) console.log(`${id} errors (${errors.length}):\n  ${errors.slice(0, 8).join("\n  ")}`);
            for (const c of browser.contexts()) await c.close();
        }
    });
}

/** Apps that never load webxdc.js: the widget never hears a hello. */
const NO_WEBXDC_JS = ["arcanecircle-balancefish", "arcanecircle-numberknight", "durian-river", "dc09-dclogin", "zalexanninev15-nexttools"];
