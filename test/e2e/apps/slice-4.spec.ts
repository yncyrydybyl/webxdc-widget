/*
 * Deep test, slice 4: one meaningful interaction per app from the webxdc.org
 * catalog and, for apps that share state through webxdc updates, a check that
 * the change reaches Bob after relay(). Writes test/real/all/deep/<id>.json.
 * EXPLORE=1 only starts each app and prints what it shows (for writing tests).
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { app, host, relay, widget } from "../real";
import { addXdc, ALICE, BOB, chats, DEEP, drag, dump, firstLine, type Log, newResult, type Peer, pressFrame, reacts, relayRealtime, type Result, saveResult, shot, stage, startPeer, toDevice, updates, watch } from "./lib";

const pick = process.env.APPS?.split(",").filter(Boolean);

test.describe.configure({ mode: "parallel" });

type Person = Peer & { log: Log };

const errorsOf = (p: Person): string[] => [...p.log.errors, ...p.log.blocked];
const text = (p: Person): Promise<string> => p.frame.evaluate(() => document.body?.innerText ?? "");
const press = (p: Person, fx = 0.5, fy = 0.5, ms = 120): Promise<void> => pressFrame(p.page, fx, fy, ms);

type Ctx = {
    alice: Person;
    r: Result;
    /** Bob (or `user`, e.g. Alice's second device) in the same room, with the app started. */
    bob: (user?: string, name?: string) => Promise<Person>;
};

type Spec = {
    shared: Result["shared_state"];
    tested: string;
    notes?: string;
    /** Cause to record when a step fails, unless the run sets one. */
    cause?: Result["cause"];
    run: (ctx: Ctx) => Promise<void>;
};

async function explore(p: Person, id: string, tag = "explore"): Promise<void> {
    await dump(p.frame, `${tag} ${id}`).catch((e) => console.log(`##### ${tag} ${id}: ${String(e)}`));
    console.log(`ERRORS ${JSON.stringify(errorsOf(p))}`);
    await shot(p.page, `${tag}-${id}`);
}

function deep(id: string, spec: Spec): void {
    if (pick && !pick.includes(id)) return;
    test(id, async ({ browser }) => {
        test.setTimeout(180_000);
        const r = newResult(id, { shared_state: spec.shared, sync_verified: spec.shared === "no" ? null : false, tested: spec.tested, notes: spec.notes ?? "" });
        const people: Person[] = [];
        let failure: unknown;
        try {
            const page = await host(browser, ALICE, "Alice");
            const log = watch(page, "Alice");
            const frame = await addXdc(page, id);
            await page.waitForTimeout(1500);
            const alice: Person = { page, frame, app: app(page), log };
            people.push(alice);
            if (process.env.EXPLORE) return void (await explore(alice, id));
            await spec.run({
                alice,
                r,
                bob: async (user = BOB, name = "Bob") => {
                    const peer = await startPeer(page, user, name);
                    const bob: Person = { ...peer, log: watch(peer.page, name) };
                    await bob.page.waitForTimeout(1500);
                    people.push(bob);
                    return bob;
                },
            });
        } catch (err) {
            failure = err;
            r.problems.push(`step failed: ${firstLine(err)}`);
            if (r.cause === "none") r.cause = spec.cause ?? "app";
            for (const [i, p] of people.entries()) await explore(p, id, `fail${i}`);
        } finally {
            const errs = [...new Set(people.flatMap(errorsOf))].slice(0, 6);
            if (errs.length) r.notes = `${r.notes}${r.notes ? " " : ""}Console: ${errs.join(" | ")}`.slice(0, 900);
            for (const [i, p] of people.entries()) await shot(p.page, `deep-${id}-${i}`);
            if (!process.env.EXPLORE) saveResult(r);
            for (const p of people) await p.page.context().close().catch(() => {});
        }
        if (failure) throw failure;
    });
}

/** webxdc-score games: Bob's board (window.highscores) after relaying Alice's score update. */
async function scoreSync(alice: Person, r: Result, bob: Ctx["bob"], waitMs: number, nudge?: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (!(await updates(alice.page)).length && Date.now() < deadline) {
        if (nudge) await nudge();
        await alice.page.waitForTimeout(1000);
    }
    const u = await updates(alice.page);
    if (!u.length) {
        r.notes += ` No score update within ${waitMs / 1000}s of play, so the board sync was not checked.`;
        return;
    }
    const b = await bob();
    await relay(alice.page, b.page, ALICE);
    await expect.poll(() => b.frame.evaluate(() => JSON.stringify((window as any).highscores.getHighScores())), { timeout: 10_000 }).toContain("Alice");
    r.notes += ` Bob's board after relay: ${await b.frame.evaluate(() => JSON.stringify((window as any).highscores.getHighScores()))}.`;
    r.sync_verified = true;
}

const specs: Record<string, Spec> = {
    // ---- Games ---------------------------------------------------------------

    "arcanecircle-arkanoid": {
        shared: "yes",
        tested: "launched the ball with a click and moved the paddle; checked the canvas and score/lives react",
        notes: "Shared state is only the webxdc-score high-score board, sent at game over.",
        run: async ({ alice, r, bob }) => {
            const canvas = alice.app.locator("canvas").first();
            const { idle, changed } = await reacts(alice.page, canvas, async () => {
                const box = (await canvas.boundingBox())!;
                await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height - 20);
                await press(alice, 0.28, 0.85);
                for (let x = 0.1; x < 0.5; x += 0.05) await alice.page.mouse.move(box.x + box.width * x * 2, box.y + box.height - 20, { steps: 3 });
            }, 1500);
            r.notes += idle ? " Canvas animates without input." : " Canvas idle before input.";
            expect(changed).toBe(true);
            r.verdict = "works";
            // Hands off the paddle: the ball is lost three times, then the score goes to the board.
            await scoreSync(alice, r, bob, 90_000, () => press(alice, 0.28, 0.85, 60));
        },
    },

    "arcanecircle-babeldungeon-fr-en": {
        shared: "yes",
        tested: "New Game, picked French (sends a lang update); checked the progress update reaches Alice's second device",
        notes: "Updates carry the player's own progress (uid = selfAddr), so sync is between one person's devices, tested with a second Alice device.",
        run: async ({ alice, r, bob }) => {
            await alice.app.getByRole("button", { name: "New Game" }).click();
            await alice.app.getByRole("button", { name: "French" }).click();
            await expect.poll(async () => (await updates(alice.page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
            await expect.poll(async () => (await text(alice)).replace(/\s+/g, " ")).toContain("LEVEL 1");
            r.verdict = "partial";
            const second = await bob(ALICE, "Alice");
            const blank = (await text(second)).replace(/\s+/g, " ");
            await relay(alice.page, second.page, ALICE);
            await second.page.waitForTimeout(1500);
            expect(blank).toContain("New Game");
            await expect.poll(async () => (await text(second)).replace(/\s+/g, " ")).toContain("LEVEL 1");
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "arcanecircle-backread": {
        shared: "yes",
        tested: "START, answered one question right and one wrong; checked the streak is sent and Bob's SCOREBOARD lists Alice after relay",
        run: async ({ alice, r, bob }) => {
            await alice.app.getByText("START", { exact: true }).click();
            const answers = alice.app.locator('div[data-scene="GamePlay"] .answer');
            const round = async (right: boolean) => {
                await expect(answers.first()).toHaveText(/\S/, { timeout: 10_000 });
                const q = (await alice.app.locator(".sentence").innerText()).trim().toLowerCase();
                const all = (await answers.allInnerTexts()).map((a) => a.trim().toLowerCase());
                const i = right ? all.indexOf(q) : all.findIndex((a) => a !== q);
                expect(i, `answer for "${q}" in ${all}`).toBeGreaterThanOrEqual(0);
                await answers.nth(i).click();
            };
            await round(true);
            await expect(alice.app.locator(".current-streak").first()).toHaveText(/1/);
            await alice.page.waitForTimeout(1500);
            await round(false);
            await expect.poll(async () => (await updates(alice.page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
            r.verdict = "partial";
            const b = await bob();
            await relay(alice.page, b.page, ALICE);
            await b.app.getByText("SCOREBOARD", { exact: true }).click();
            await expect(b.app.locator("#scoreboard")).toContainText("Alice");
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "arcanecircle-c4": {
        shared: "yes",
        tested: "Alice joins, Bob joins (relayed both ways), Alice drops a disc; checked Bob's board shows the disc after relay",
        run: async ({ alice, r, bob }) => {
            const discs = (p: Person) => p.frame.evaluate(() => document.querySelectorAll("section.board .player1, section.board .player2").length);
            await alice.app.getByRole("button", { name: "Join" }).click();
            await expect.poll(async () => (await updates(alice.page)).length).toBeGreaterThan(0);
            await expect(alice.app.getByText(/Waiting for another player/)).toBeVisible();
            const b = await bob();
            let seen = await relay(alice.page, b.page, ALICE);
            await b.app.getByRole("button", { name: "Join" }).click();
            await expect.poll(async () => (await updates(b.page)).length).toBeGreaterThan(0);
            await relay(b.page, alice.page, BOB);
            await expect(alice.app.getByText("Your turn")).toBeVisible();
            seen = await relay(alice.page, b.page, ALICE, seen);
            const n0 = (await updates(alice.page)).length;
            const d0 = await discs(b);
            const cells = alice.app.locator("section.board > *");
            await cells.nth(38).click();
            await expect.poll(() => discs(alice)).toBe(1);
            await expect.poll(async () => (await updates(alice.page)).length).toBeGreaterThan(n0);
            r.verdict = "partial";
            seen = await relay(alice.page, b.page, ALICE, seen);
            await expect.poll(() => text(b)).toMatch(/Your turn/);
            expect(d0).toBe(0);
            await expect.poll(() => discs(b)).toBe(1);
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "arcanecircle-crappybird": {
        shared: "yes",
        tested: "clicked the canvas to start and flap; checked the canvas reacts",
        notes: "Shared state is only the webxdc-score board, sent at game over with a new best.",
        run: async ({ alice, r, bob }) => {
            const { changed } = await reacts(alice.page, alice.app.locator("canvas").first(), async () => {
                for (let i = 0; i < 4; i++) await press(alice, 0.5, 0.5, 80);
            }, 600);
            expect(changed).toBe(true);
            r.verdict = "works";
            // No more flaps: the bird falls, game over, the score goes to the board.
            await scoreSync(alice, r, bob, 20_000);
        },
    },

    "arcanecircle-idlenecromancer": {
        shared: "no",
        tested: "clicked the canvas several times; checked the canvas reacts",
        run: async ({ alice, r }) => {
            const { changed } = await reacts(alice.page, alice.app.locator("canvas").first(), async () => {
                for (let i = 0; i < 5; i++) await press(alice, 0.5, 0.5, 80);
            });
            expect(changed).toBe(true);
            r.verdict = "works";
        },
    },

    "arcanecircle-musasquest": {
        shared: "no",
        tested: "clicked the king; checked the dialogue box (#B) shows text",
        notes: "Only sends an info update with a null payload on finishing the quest; no listener.",
        run: async ({ alice, r }) => {
            await press(alice, 0.5, 0.4);
            await expect(alice.app.locator("#B")).toBeVisible({ timeout: 5000 });
            r.notes += ` Dialogue: "${(await alice.app.locator("#B").innerText()).slice(0, 80)}"`;
            r.verdict = "works";
        },
    },

    "arcanecircle-rainbow": {
        shared: "yes",
        tested: "Start Game, answered 2 colour questions right and 1 wrong; checked Bob's scoreboard shows Alice's score after relay",
        run: async ({ alice, r, bob }) => {
            const answer = () =>
                alice.frame.evaluate(() => {
                    const q = document.querySelector("h2.question")!;
                    const read = !!document.querySelector(".highlight");
                    return read ? q.textContent!.trim() : q.className.split("_q")[0];
                });
            await alice.app.getByRole("button", { name: "Start Game" }).click();
            for (let i = 0; i < 2; i++) {
                const a = await answer();
                await alice.app.locator(`section.group button[value="${a}"]`).click();
                await expect(alice.app.locator("h2.score")).toHaveText(String(i + 1));
            }
            const a = await answer();
            const wrong = ["red", "blue", "green", "yellow"].find((c) => c !== a)!;
            await alice.app.locator(`section.group button[value="${wrong}"]`).click();
            await expect(alice.app.getByRole("button", { name: "Play Again" })).toBeVisible();
            await expect.poll(async () => (await updates(alice.page)).length).toBeGreaterThan(0);
            r.verdict = "partial";
            const b = await bob();
            await expect(b.app.getByText("No records yet")).toBeVisible();
            await relay(alice.page, b.page, ALICE);
            await expect(b.app.locator(".scoreboardlist")).toContainText("Alice");
            await expect(b.app.locator(".scoreboardlist")).toContainText("2");
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "arcanecircle-stackup": {
        shared: "yes",
        tested: "clicked to start and placed blocks until game over; checked the score is sent and Bob's scoreboard lists Alice after relay",
        run: async ({ alice, r, bob }) => {
            await press(alice, 0.5, 0.5);
            await alice.page.waitForTimeout(700);
            for (let i = 0; i < 6; i++) {
                await press(alice, 0.5, 0.5, 60);
                await alice.page.waitForTimeout(400);
            }
            await expect.poll(async () => (await updates(alice.page)).length, { timeout: 30_000 }).toBeGreaterThan(0);
            const u = (await updates(alice.page))[0];
            r.notes += ` Score update: ${JSON.stringify(u.content).slice(0, 160)}.`;
            r.verdict = "partial";
            const b = await bob();
            await relay(alice.page, b.page, ALICE);
            await b.page.waitForTimeout(800);
            await b.app.locator("#score-btn").click({ force: true });
            await expect(b.app.locator("#scoreboard-container")).toContainText("Alice");
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "arcanecircle-takuzu": {
        shared: "yes",
        tested: "Play, picked the first board size, tapped an empty tile; checked the tile changes colour",
        notes: "Shared state is only the webxdc-score board, sent when a puzzle is solved (not attempted).",
        run: async ({ alice, r }) => {
            await alice.app.getByText("Play", { exact: true }).click();
            await alice.page.waitForTimeout(800);
            await alice.app.locator('[data-action="startGame"][data-size="1"]').click();
            await alice.page.waitForTimeout(1500);
            const tiles = alice.app.locator("#board .tile");
            const classes = await tiles.evaluateAll((ts) => ts.map((t) => t.className));
            console.log("takuzu tiles", classes.length, classes.slice(0, 16));
            const idx = classes.findIndex((c) => /tile-0\b/.test(c) || !/tile-[12]/.test(c));
            await tiles.nth(idx).click();
            await alice.page.waitForTimeout(500);
            const after = await tiles.nth(idx).getAttribute("class");
            console.log("takuzu clicked", classes[idx], "->", after);
            expect(after).not.toBe(classes[idx]);
            r.verdict = "works";
        },
    },

    "arcanecircle-tiny-yurts": {
        shared: "yes",
        tested: "pressed Start, dragged from a yurt; checked the menu closes and the game runs",
        notes: "Shared state is only the webxdc-score board, sent at game over (minutes in).",
        run: async ({ alice, r }) => {
            await alice.app.getByRole("button", { name: "Start", exact: true }).click();
            await expect.poll(() => text(alice)).toMatch(/^\s*\d+\s+[A-Z][a-z]{2}\b/); // the calendar of a running game
            const before = await alice.page.screenshot();
            await alice.page.mouse.move(400, 400);
            await alice.page.mouse.down();
            await alice.page.mouse.move(500, 450, { steps: 8 });
            await alice.page.mouse.up();
            await alice.page.waitForTimeout(1500);
            expect((await alice.page.screenshot()).equals(before)).toBe(false);
            r.verdict = "works";
        },
    },

    "davidsm10-checkers": {
        shared: "yes",
        tested: "Alice starts a game, Bob joins (relayed), Alice moves a piece; checked Bob's board shows the move after relay",
        run: async ({ alice, r, bob }) => {
            const board = (p: Person) => p.frame.evaluate(() => [...document.querySelectorAll(".board > button")].map((b) => (b.querySelector(".piece.dark") ? "d" : b.querySelector(".piece.light") ? "l" : ".")).join(""));
            await alice.app.getByRole("button", { name: "Start game" }).click();
            await expect.poll(async () => (await updates(alice.page)).length).toBeGreaterThan(0);
            const b = await bob();
            let seen = await relay(alice.page, b.page, ALICE);
            await b.app.getByRole("button", { name: "Join game" }).click();
            await expect.poll(async () => (await updates(b.page)).length).toBeGreaterThan(0);
            await relay(b.page, alice.page, BOB);
            await expect(alice.app.getByText(/Turn: Alice/)).toBeVisible();
            const squares = alice.app.locator(".board > button");
            const start = await board(alice);
            // A dark piece on the front row with a free square diagonally ahead.
            let moved = false;
            for (let i = 0; i < 64 && !moved; i++) {
                if (start[i] !== "d") continue;
                for (const t of [i - 7, i - 9]) {
                    if (t < 0 || start[t] !== "." || Math.abs((t % 8) - (i % 8)) !== 1) continue;
                    if (await squares.nth(i).isDisabled()) continue;
                    await squares.nth(i).click();
                    if (await squares.nth(t).isDisabled()) continue;
                    await squares.nth(t).click();
                    moved = true;
                    break;
                }
            }
            expect(moved, "found a legal first move").toBe(true);
            await expect(alice.app.getByText(/Turn: Bob/)).toBeVisible();
            await alice.page.waitForTimeout(1000);
            const after = await board(alice);
            expect(after).not.toBe(start);
            r.verdict = "partial";
            await expect.poll(async () => (await updates(alice.page)).length).toBeGreaterThan(1);
            seen = await relay(alice.page, b.page, ALICE, seen);
            await expect(b.app.getByText(/Turn: Bob/)).toBeVisible();
            // Bob sees the board from the other side: the same squares, reversed.
            await expect.poll(async () => [...(await board(b))].reverse().join("")).toBe(await board(alice));
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "mestermim-tic-tac-toe": {
        shared: "yes",
        tested: "both press I'm Ready, Alice plays X in the centre; checked Bob's board shows X after relay, Bob plays O, Alice sees it",
        run: async ({ alice, r, bob }) => {
            const cell = (p: Person, i: number) => p.app.locator("#board > div").nth(i);
            await alice.app.getByRole("button", { name: "I'm Ready!" }).click();
            await cell(alice, 4).click();
            await expect(cell(alice, 4)).toHaveText("X");
            await expect.poll(async () => (await updates(alice.page)).length).toBeGreaterThan(0);
            r.verdict = "partial";
            const b = await bob();
            let seen = await relay(alice.page, b.page, ALICE);
            await b.app.getByRole("button", { name: "I'm Ready!" }).click();
            await expect(cell(b, 4)).toHaveText("X");
            await cell(b, 0).click();
            await expect(cell(b, 0)).toHaveText("O");
            await expect.poll(async () => (await updates(b.page)).length).toBeGreaterThan(0);
            await relay(b.page, alice.page, BOB);
            await expect(cell(alice, 0)).toHaveText("O");
            seen = await relay(alice.page, b.page, ALICE, seen);
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "sbkaf-the-wandering-wraith": {
        shared: "yes",
        tested: "New game, held the right arrow and jumped; checked the canvas reacts",
        notes: "Shared state is a highscore list sent when a level is finished.",
        run: async ({ alice, r }) => {
            await alice.app.getByRole("button", { name: "New game" }).click();
            await alice.page.waitForTimeout(1000);
            const canvas = alice.app.locator("canvas").first();
            const { changed } = await reacts(alice.page, canvas, async () => {
                await canvas.click({ force: true }).catch(() => {});
                await alice.page.keyboard.down("ArrowRight");
                await alice.page.waitForTimeout(800);
                await alice.page.keyboard.press("ArrowUp");
                await alice.page.waitForTimeout(400);
                await alice.page.keyboard.up("ArrowRight");
            }, 0);
            expect(changed).toBe(true);
            r.verdict = "works";
        },
    },

    // ---- Tools ---------------------------------------------------------------

    "arcanecircle-filesync": {
        shared: "realtime",
        tested: "added a file with +; Bob joins, realtime data relayed both ways; checked Bob's peer count / file list",
        run: async ({ alice, r, bob }) => {
            await alice.app.locator('input[type="file"]').setInputFiles({ name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("hello from alice") });
            await expect(alice.app.getByText("hello.txt")).toBeVisible();
            r.verdict = "partial";
            const b = await bob();
            let sa = 0, sb = 0;
            for (let i = 0; i < 6; i++) {
                await alice.page.waitForTimeout(1500);
                sa = await relayRealtime(alice.page, b.page, ALICE, sa);
                sb = await relayRealtime(b.page, alice.page, BOB, sb);
            }
            console.log("filesync bob", (await text(b)).slice(0, 300), sa, sb);
            await expect(b.app.getByText("hello.txt")).toBeVisible({ timeout: 10_000 });
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "arcanecircle-textcards": {
        shared: "no",
        tested: "typed a text on the card, pressed Send..., confirmed in the widget; checked a card image is posted to the room",
        run: async ({ alice, r }) => {
            const card = alice.app.locator("[contenteditable]").first();
            await card.click();
            await alice.page.keyboard.press("Control+A");
            await alice.page.keyboard.type("Happy birthday");
            await alice.app.getByRole("button", { name: "Send..." }).click();
            await widget(alice.page).getByRole("button", { name: "Send", exact: true }).click({ timeout: 15_000 });
            await expect.poll(async () => (await chats(alice.page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
            const msg = (await chats(alice.page))[0];
            r.notes += ` Posted: ${JSON.stringify(msg.content).slice(0, 200)}`;
            r.verdict = "works";
            if (msg.content.msgtype !== "m.image") {
                r.problems.push(`card.jpeg posted as ${msg.content.msgtype} with mimetype "${msg.content.info?.mimetype}": the app passes file.type "image" (not a MIME type) and runner/shim.js + src/room.ts sendToChat take it as the mimetype instead of deriving image/jpeg from the name`);
                r.cause = "widget";
                r.verdict = "partial";
            }
        },
    },

    "davidsm10-poll": {
        shared: "yes",
        tested: "Alice creates a poll; Bob sees it after relay and votes; Alice sees Bob's vote in the results",
        run: async ({ alice, r, bob }) => {
            const inputs = alice.app.locator("input.input");
            await inputs.nth(0).fill("Lunch?");
            await inputs.nth(1).fill("Pizza");
            await inputs.nth(2).fill("Sushi");
            await alice.app.getByRole("button", { name: "Create" }).click();
            await expect.poll(async () => (await updates(alice.page)).length).toBeGreaterThan(0);
            await expect(alice.app.getByText("Lunch?")).toBeVisible();
            r.verdict = "partial";
            const b = await bob();
            let seen = await relay(alice.page, b.page, ALICE);
            await expect(b.app.getByText("Lunch?")).toBeVisible();
            await b.app.getByText("Sushi").click();
            await b.app.getByRole("button", { name: "Vote" }).click();
            await expect.poll(async () => (await updates(b.page)).length).toBeGreaterThan(0);
            await b.page.waitForTimeout(500);
            console.log("poll bob after vote", (await text(b)).slice(0, 300));
            await relay(b.page, alice.page, BOB);
            await alice.app.getByText("View Results").click().catch(() => {});
            await alice.page.waitForTimeout(800);
            console.log("poll alice results", (await text(alice)).slice(0, 300));
            await expect.poll(() => text(alice)).toMatch(/1 (vote|people|person)|100 ?%/i);
            seen = await relay(alice.page, b.page, ALICE, seen);
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "durian-rain": {
        shared: "no",
        tested: "waited for rain.mp3 to load, clicked the canvas to start the rain sound; checked the Howl plays",
        cause: "app",
        run: async ({ alice, r }) => {
            const state = () => alice.frame.evaluate("({ ctx: Howler.ctx && Howler.ctx.state, state: sound.state(), playing: sound.playing(), text: audioText })") as Promise<any>;
            await expect.poll(async () => (await state()).state, { timeout: 20_000 }).toBe("loaded");
            r.verdict = "partial";
            r.cause = "app";
            await press(alice, 0.5, 0.5, 150);
            await alice.page.waitForTimeout(1000);
            if (!(await state()).playing) {
                await alice.app.locator("#defaultCanvas0").click({ force: true });
                await alice.page.waitForTimeout(1000);
            }
            if (!(await state()).playing) {
                r.problems.push("Real mouse clicks on the canvas do not toggle the sound (p5 cnv.mouseClicked(playNoise) never fires); the same happens with the app opened standalone from file:// in Chromium, so not the widget. A dispatched click event does start it.");
                await alice.frame.evaluate("document.querySelector('#defaultCanvas0').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
                await alice.page.waitForTimeout(1000);
            }
            await expect.poll(async () => (await state()).playing).toBe(true);
            r.notes += ` Playing: ${JSON.stringify(await state())}.`;
            if (!r.problems.length) {
                r.verdict = "works";
                r.cause = "none";
            }
            if (errorsOf(alice).some((e) => /accelerometer|devicemotion|deviceorientation/i.test(e))) {
                r.problems.push("Minor (widget): Permissions policy blocks accelerometer/devicemotion/deviceorientation in the app frame (src/Player.svelte iframe allow=\"fullscreen; autoplay; clipboard-write\"); p5.js listens for device motion at start. Harmless here.");
                if (r.cause === "none") r.cause = "widget";
            }
        },
    },

    excalidraw: {
        shared: "realtime",
        tested: "Bob and Alice open the board, Alice draws a rectangle; realtime data relayed to Bob, checked his canvas changes; Ctrl+S sends a webxdc update",
        notes: "With realtime available, strokes travel over joinRealtimeChannel; sendUpdate only on Ctrl+S (or autosave when realtime is off).",
        run: async ({ alice, r, bob }) => {
            const closeHelp = async (p: Person) => {
                const close = p.app.locator(".webxdc-help-modal__close");
                if (await close.isVisible()) await close.click();
            };
            await alice.page.waitForTimeout(1500);
            await closeHelp(alice);
            const b = await bob();
            await b.page.waitForTimeout(2000);
            await closeHelp(b);
            let sa = await relayRealtime(alice.page, b.page, ALICE);
            let sb = await relayRealtime(b.page, alice.page, BOB);
            const interactive = b.app.locator("canvas.excalidraw__canvas.interactive, canvas").first();
            const before = await interactive.screenshot();
            const { changed: staticChanged } = await reacts(b.page, b.app.locator("canvas").first(), async () => {
                await alice.page.keyboard.press("r");
                await drag(alice.page, stage(alice.page), [0.35, 0.4], [0.6, 0.65], 10);
                await expect.poll(async () => (await toDevice(alice.page)).length, { timeout: 10_000 }).toBeGreaterThan(sa);
                r.verdict = "partial";
                for (let i = 0; i < 3; i++) {
                    await alice.page.waitForTimeout(700);
                    sa = await relayRealtime(alice.page, b.page, ALICE, sa);
                    sb = await relayRealtime(b.page, alice.page, BOB, sb);
                }
            }, 1500);
            const changed = staticChanged || !(await interactive.screenshot()).equals(before);
            expect(changed, "Bob's canvas shows Alice's rectangle").toBe(true);
            r.sync_verified = true;
            r.verdict = "works";
            const n0 = (await updates(alice.page)).length;
            await alice.page.keyboard.press("Control+s");
            await expect.poll(async () => (await updates(alice.page)).length, { timeout: 10_000 }).toBeGreaterThan(n0);
            r.notes += " Ctrl+S sent a webxdc update.";
        },
    },

    "guile-hoot-meta-repl": {
        shared: "no",
        tested: "typed (* 6 7) and Enter in the REPL; checked it prints 42",
        run: async ({ alice, r }) => {
            await alice.app.locator("#expression").fill("(* 6 7)");
            await alice.app.locator("#expression").press("Enter");
            await expect.poll(() => text(alice)).toMatch(/\b42\b/);
            r.verdict = "works";
        },
    },

    "link2xt-skedz": {
        shared: "yes",
        tested: "imported a small frab schedule.json; checked it loads and reaches Bob after relay; liked a session",
        run: async ({ alice, r, bob }) => {
            const schedule = {
                schedule: {
                    version: "1",
                    conference: {
                        acronym: "tc", title: "Test Conf", start: "2030-01-01", end: "2030-01-01", timeslot_duration: "00:30", time_zone_name: "UTC",
                        days: [{ index: 1, date: "2030-01-01", day_start: "2030-01-01T09:00:00+00:00", day_end: "2030-01-01T18:00:00+00:00",
                            rooms: { "Room A": [{ guid: "11111111-1111-1111-1111-111111111111", id: 1, date: "2030-01-01T10:00:00+00:00", start: "10:00", duration: "00:30", room: "Room A", slug: "t1", title: "Webxdc in Matrix", subtitle: "", track: "Main", type: "talk", language: "en", abstract: "", description: "", persons: [{ public_name: "Alice" }], links: [], attachments: [] }] } }],
                    },
                },
            };
            await alice.app.locator('input[type="file"]').first().setInputFiles({ name: "schedule.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(schedule)) });
            await alice.page.waitForTimeout(1000);
            const load = alice.app.getByRole("button", { name: "Load schedule" });
            if (await load.isVisible()) await load.click();
            await expect.poll(async () => (await updates(alice.page)).length, { timeout: 15_000 }).toBeGreaterThan(0);
            await alice.page.waitForTimeout(1500);
            console.log("skedz alice", (await text(alice)).slice(0, 400));
            r.verdict = "partial";
            const b = await bob();
            await relay(alice.page, b.page, ALICE);
            await b.page.waitForTimeout(1500);
            console.log("skedz bob", (await text(b)).slice(0, 400));
            await expect(b.app.getByText("Webxdc in Matrix").first()).toBeVisible();
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "mestermim-scientific-calculator": {
        shared: "no",
        tested: "pressed 7 × 6 =; checked the display shows 42",
        run: async ({ alice, r }) => {
            for (const k of ["7", "×", "6", "="]) await alice.app.getByRole("button", { name: k, exact: true }).click();
            await expect.poll(() => text(alice)).toMatch(/\b42\b/);
            console.log("calc", (await text(alice)).slice(0, 100));
            r.verdict = "works";
        },
    },

    "r10s-congrats": {
        shared: "yes",
        tested: "edited the greeting text and tapped outside; checked Bob sees the new greeting after relay",
        run: async ({ alice, r, bob }) => {
            await alice.app.locator("#text").click();
            await alice.page.keyboard.press("Control+A");
            await alice.page.keyboard.type("Happy birthday Bob");
            await press(alice, 0.5, 0.9);
            await expect.poll(async () => (await updates(alice.page)).length).toBeGreaterThan(0);
            r.verdict = "partial";
            const b = await bob();
            await relay(alice.page, b.page, ALICE);
            await expect(b.app.locator("#text")).toHaveText("Happy birthday Bob");
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "sbkaf-wishlist": {
        shared: "yes",
        tested: "added a wish with name and description; checked Bob sees it under wish lists after relay",
        run: async ({ alice, r, bob }) => {
            const n0 = (await updates(alice.page)).length;
            await alice.app.getByRole("button", { name: "add wish" }).click();
            await alice.app.locator("#name").fill("Red bicycle");
            await alice.app.locator("#description").fill("with a bell");
            await alice.app.getByRole("button", { name: "add", exact: true }).click();
            await expect.poll(async () => (await updates(alice.page)).length).toBeGreaterThan(n0);
            await expect.poll(() => text(alice)).toContain("Red bicycle");
            r.verdict = "partial";
            const b = await bob();
            await relay(alice.page, b.page, ALICE);
            await b.app.getByRole("button", { name: "wish lists" }).click();
            await b.page.waitForTimeout(500);
            console.log("wish bob", (await text(b)).slice(0, 300));
            const alices = b.app.getByText("Alice").first();
            if (await alices.isVisible()) await alices.click();
            await expect.poll(() => text(b)).toContain("Red bicycle");
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "webratte-i-got-time": {
        shared: "yes",
        tested: "created an appointment request with one date; checked Bob sees it after relay",
        run: async ({ alice, r, bob }) => {
            await alice.app.locator("#btnInput").click();
            await expect(alice.app.locator("#inputTitle")).toBeVisible();
            await alice.app.locator("#inputTitle").fill("Team dinner");
            await alice.app.locator("#inputDate1").fill("2030-05-01");
            await alice.app.locator("#inputTime1").fill("19:00");
            await alice.app.locator("#btnSend").click();
            await expect.poll(async () => (await updates(alice.page)).length).toBeGreaterThan(0);
            await alice.page.waitForTimeout(1000);
            console.log("igt alice", (await text(alice)).slice(0, 300));
            r.verdict = "partial";
            const b = await bob();
            await relay(alice.page, b.page, ALICE);
            await expect.poll(() => text(b)).toContain("Team dinner");
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "webxdc-editor": {
        shared: "yes",
        tested: "typed a paragraph; checked the Yjs update is sent and Bob sees the text after relay",
        run: async ({ alice, r, bob }) => {
            await alice.app.locator("[contenteditable=true]").first().click();
            await alice.page.keyboard.type("Hello from Alice");
            await expect.poll(async () => (await updates(alice.page)).length, { timeout: 25_000 }).toBeGreaterThan(0);
            r.verdict = "partial";
            const b = await bob();
            await relay(alice.page, b.page, ALICE);
            await expect(b.app.locator("[contenteditable=true]").first()).toContainText("Hello from Alice");
            r.sync_verified = true;
            r.verdict = "works";
        },
    },

    "yosvanyalain-creator-studio": {
        shared: "yes",
        tested: "New app > With blocks > Create this app: the block editor opens with a shared-counter app; opened the Test preview and tapped +1 (count 0 -> 1)",
        notes: "The studio's own sendUpdate use is for apps built in it (preview simulates chat members); not exercised between people.",
        run: async ({ alice, r }) => {
            await alice.app.getByRole("button", { name: "New app" }).click();
            await alice.app.getByText("With blocks", { exact: true }).click();
            await alice.app.getByRole("button", { name: "Create this app" }).click();
            await alice.page.waitForTimeout(2000);
            await expect(alice.app.getByText(/is in My apps/)).toBeVisible();
            r.verdict = "partial";
            await alice.app.getByText("Test", { exact: true }).first().click();
            await alice.page.waitForTimeout(2500);
            const preview = alice.app.frameLocator("iframe").first();
            await preview.locator("#tap").click();
            await expect(preview.locator("#count")).toHaveText("1");
            r.notes += " The srcdoc preview inside the app runs; tapping +1 counts.";
            r.verdict = "works";
        },
    },
};

for (const id of readFileSync(`${DEEP}/slice-4.txt`, "utf8").split("\n").filter(Boolean)) {
    if (process.env.EXPLORE) deep(id, { shared: "unknown", tested: "", run: async () => {} });
    else if (specs[id]) deep(id, specs[id]);
}
