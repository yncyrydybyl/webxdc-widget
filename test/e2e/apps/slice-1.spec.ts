/*
 * Deep test, slice 1: one meaningful interaction per app, and for apps that share
 * state through webxdc updates (or realtime), that the change reaches Bob.
 * Writes test/real/all/deep/<id>.json. APPS=id,id picks some.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Frame, type FrameLocator, type Page } from "@playwright/test";
import { app, host, relay, widget } from "../real";
import { addXdc, ALICE, appFrame, BOB, chats, DEEP, dump, firstLine, hold, type Log, newResult, overlay, reacts, relayRealtime, type Result, saveResult, shot, stage, startPeer, toDevice, until, updates, watch } from "./lib";

/** The MP3 fixture of amzd-radio-station lives in the session scratchpad. */
const ids = readFileSync(`${DEEP}/slice-1.txt`, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const pick = process.env.APPS?.split(",");

test.describe.configure({ mode: "parallel" });
test.use({ actionTimeout: 10_000 });

class Person {
    readonly log: Log;
    sentSeen = 0;
    rtSeen = 0;
    constructor(readonly page: Page, readonly user: string) {
        this.log = watch(page);
    }
    get app(): FrameLocator {
        return app(this.page);
    }
    frame(): Promise<Frame> {
        return appFrame(this.page);
    }
    async updates(): Promise<number> {
        return (await updates(this.page)).length;
    }
    /** Some update sent so far contains this text (in its JSON). */
    async sent(text: string): Promise<boolean> {
        return (await updates(this.page)).some((s: any) => JSON.stringify(s.content).includes(text));
    }
    toDevice(): Promise<any[]> {
        return toDevice(this.page);
    }
    /** Room events this person sent so far, delivered to the other. */
    async relayTo(to: Person): Promise<void> {
        this.sentSeen = await relay(this.page, to.page, this.user, this.sentSeen);
    }
    /** Realtime (to-device) data this person sent so far, delivered to the other. */
    async relayRealtime(to: Person): Promise<void> {
        this.rtSeen = await relayRealtime(this.page, to.page, this.user, this.rtSeen);
    }
}

interface Ctx {
    alice: Person;
    a: FrameLocator;
    /** Another device in the room: Bob by default, or a second device of Alice. */
    bob: (user?: string, name?: string) => Promise<Person>;
    note: (s: string) => void;
}

type Base = Omit<Result, "id" | "name" | "verdict" | "sync_verified" | "problems" | "cause" | "notes"> & Partial<Pick<Result, "sync_verified" | "problems" | "cause" | "notes">> & { overlay?: boolean };

function deep(id: string, base: Base, body: (c: Ctx) => Promise<Partial<Result> | void>): void {
    if (!ids.includes(id)) throw new Error(`not in slice: ${id}`);
    (pick && !pick.includes(id) ? test.skip : test)(id, async ({ browser }) => {
        test.setTimeout(120_000);
        const { overlay: covered, ...fields } = base;
        const alice = new Person(await host(browser, ALICE, "Alice"), ALICE);
        let bob: Person | undefined;
        const notes: string[] = [];
        let out: Result;
        let failure: unknown;
        try {
            await addXdc(alice.page, id, !covered);
            await alice.page.waitForTimeout(1500);
            const r = await body({
                alice,
                a: alice.app,
                note: (s) => notes.push(s),
                bob: async (user = BOB, who = "Bob") => {
                    bob = new Person((await startPeer(alice.page, user, who)).page, user);
                    await bob.page.waitForTimeout(1500);
                    return bob;
                },
            });
            out = newResult(id, { verdict: "works", sync_verified: base.shared_state === "no" ? null : false, ...fields, ...(r ?? {}) });
        } catch (err) {
            failure = err;
            out = newResult(id, { verdict: "broken", sync_verified: base.shared_state === "no" ? null : false, ...fields, problems: [firstLine(err)], cause: "test-harness" });
            await shot(alice.page, `${id}.fail-alice`);
            if (bob) await shot(bob.page, `${id}.fail-bob`);
        }
        await shot(alice.page, `${id}.alice`);
        if (bob) await shot(bob.page, `${id}.bob`);
        const console_errors = [...new Set([...alice.log.errors, ...(bob?.log.errors ?? [])])].slice(0, 8);
        const result = { ...out, notes: [out.notes, ...notes].filter(Boolean).join(" "), console_errors };
        saveResult(result);
        await alice.page.context().close();
        await bob?.page.context().close();
        if (failure) throw failure;
    });
}

// ---------------------------------------------------------------- games

deep("acbnnick-scramble", { shared_state: "yes", tested: "Alice joins the lobby, Bob sees her, Bob joins, Alice sees him" }, async ({ alice, a, bob }) => {
    await a.getByRole("button", { name: "Join Game" }).click();
    await expect(a.locator(".lobby-players")).toContainText("Alice");
    await until(() => alice.updates()).toBeGreaterThan(0);
    const b = await bob();
    await alice.relayTo(b);
    await expect(b.app.locator(".lobby-players")).toContainText("Alice");
    await b.app.getByRole("button", { name: "Join Game" }).click();
    await until(() => b.updates()).toBeGreaterThan(0);
    await b.relayTo(alice);
    await expect(a.locator(".lobby-players")).toContainText("Bob");
    return { sync_verified: true };
});

// ---------------------------------------------------------------- tools

deep("bespinas-divvy-bill", { shared_state: "yes", tested: "Alice joins and adds an expense 'Dinner' 30, Bob joins and sees it" }, async ({ alice, a, bob }) => {
    await a.getByRole("button", { name: "Join" }).click();
    await a.getByRole("button", { name: "New expense" }).click();
    await a.getByPlaceholder("Tickets, dinner...").fill("Dinner");
    await a.getByPlaceholder("0.0").fill("30");
    await a.locator('#split-between input[type="checkbox"]').first().check();
    await a.getByRole("button", { name: "Save" }).first().click();
    await expect(a.locator("#expenses")).toContainText("Dinner");
    await until(() => alice.sent("serializedYjsUpdate"), 15_000).toBe(true);
    const b = await bob();
    await alice.relayTo(b);
    const join = b.app.getByRole("button", { name: "Join" });
    if (await join.isVisible()) await join.click();
    await expect(b.app.locator("#expenses")).toContainText("Dinner");
    return { sync_verified: true };
});

deep("durian-splitbill", { shared_state: "yes", tested: "Alice adds an expense 'Coffee' 12.50, Bob sees it" }, async ({ alice, a, bob }) => {
    await a.getByRole("button", { name: "New expense" }).click();
    await a.locator("#input-notes").fill("Coffee");
    await a.locator("#input-expenses").fill("12.50");
    await a.getByRole("button", { name: "Save" }).first().click();
    await expect(a.locator("#expenses")).toContainText("Coffee");
    // Yjs updates go out every sendUpdateInterval (5 s here).
    await until(() => alice.sent("serializedYjsUpdate"), 15_000).toBe(true);
    const b = await bob();
    await alice.relayTo(b);
    await expect(b.app.locator("#expenses")).toContainText("Coffee");
    return { sync_verified: true };
});

deep("experintellia-ordered-shopping-list", { shared_state: "yes", tested: "Alice adds 'Milk', Bob sees it, Bob adds 'Bread', Alice sees it" }, async ({ alice, a, bob }) => {
    await a.getByPlaceholder("Add an item…").fill("Milk");
    await a.getByRole("button", { name: "Add", exact: true }).click();
    await expect(a.locator("main")).toContainText("Milk");
    await until(() => alice.updates()).toBeGreaterThan(0);
    const b = await bob();
    await alice.relayTo(b);
    await expect(b.app.locator("main")).toContainText("Milk");
    await b.app.getByPlaceholder("Add an item…").fill("Bread");
    await b.app.getByRole("button", { name: "Add", exact: true }).click();
    await until(() => b.updates()).toBeGreaterThan(0);
    await b.relayTo(alice);
    await expect(a.locator("main")).toContainText("Bread");
    return { sync_verified: true };
});

deep("jooray-d21poll", { shared_state: "yes", tested: "Alice creates a poll and votes, Bob sees the question and Alice's vote" }, async ({ alice, a, bob }) => {
    await a.locator("#configureQuestion").fill("Lunch?");
    await a.locator("#configureAnswer0").fill("Pizza");
    await a.locator("#configureAnswer1").fill("Sushi");
    await a.getByText("Create Poll").click();
    await expect(a.locator("#voteQuestion")).toHaveText("Lunch?");
    await a.locator("#voteCheckboxes input").first().check();
    await a.getByText("Vote", { exact: true }).click();
    await until(() => alice.updates()).toBeGreaterThan(1);
    const b = await bob();
    await alice.relayTo(b);
    await expect(b.app.locator("#voteQuestion")).toHaveText("Lunch?");
    await b.app.getByText("View Results").click();
    await expect(b.app.locator("#resultsTotalVotes")).toHaveText("1");
    return { sync_verified: true };
});

deep("maplediss-quiet-checklists", { shared_state: "yes", tested: "Alice creates a shared checklist 'Canoe trip', Bob sees it" }, async ({ alice, a, bob }) => {
    await a.getByRole("button", { name: /New checklist/ }).click();
    await a.locator('#modal input[name="title"]').fill("Canoe trip");
    await a.locator('#modal input[name="shared"]').check();
    await a.getByRole("button", { name: "Create checklist" }).click();
    await expect(a.locator("#app")).toContainText("Canoe trip");
    await until(() => alice.updates()).toBeGreaterThan(0);
    const b = await bob();
    await alice.relayTo(b);
    await expect(b.app.locator("#app")).toContainText("Canoe trip");
    return { sync_verified: true };
});

deep("zerosum-table", { shared_state: "yes", tested: "Alice enters a row 5 / -5 and adds it, Bob sees the totals" }, async ({ alice, a, bob }) => {
    const n0 = await alice.updates();
    await a.locator("#newRow input").first().fill("5");
    await a.locator("#newRow input").nth(1).fill("-5");
    await a.getByRole("button", { name: "Add Row" }).click();
    await expect(a.locator("#totals")).toContainText("5");
    await until(() => alice.updates()).toBeGreaterThan(n0);
    const b = await bob();
    await alice.relayTo(b);
    await expect(b.app.locator("#totals td").first()).toHaveText("5");
    return { sync_verified: true };
});

deep("arcanecircle-pixelsocial", { shared_state: "yes", tested: "Alice writes a post 'Hello room', Bob sees it in his feed" }, async ({ alice, a, bob }) => {
    await a.getByLabel("New Post").click();
    await a.getByPlaceholder("What's on your mind?").fill("Hello room");
    await a.getByRole("button", { name: "Post" }).click();
    await expect(a.locator("#app")).toContainText("Hello room");
    await until(() => alice.updates()).toBeGreaterThan(0);
    const b = await bob();
    await alice.relayTo(b);
    await expect(b.app.locator("#app")).toContainText("Hello room");
    return { sync_verified: true };
});

deep("webxdc-calendar", { shared_state: "yes", tested: "Alice taps a week-view slot and adds an event 'Dentist', Bob sees it in his week view" }, async ({ alice, a, bob }) => {
    await a.locator("#weekViewGrid > div").nth(18).click();
    await a.locator("#editEventTitle").fill("Dentist");
    await a.locator("#editEventOkButton").click();
    await alice.page.waitForTimeout(500);
    await dump(await alice.frame(), "calendar");
    await expect(a.locator("#viewContainer")).toContainText("Dentist");
    await until(() => alice.updates()).toBeGreaterThan(0);
    const b = await bob();
    await alice.relayTo(b);
    await expect(b.app.locator("#viewContainer")).toContainText("Dentist");
    return { sync_verified: true };
});

deep("rtn-totp", { shared_state: "yes", tested: "Alice adds a TOTP account 'GitHub' with a base32 key, a code shows; Bob sees the account" }, async ({ alice, a, bob }) => {
    await a.locator(".plus-icon").click();
    await a.locator("input[name=name]").fill("GitHub");
    await a.locator("#add-account-input-key").fill("JBSWY3DPEHPK3PXP");
    await a.locator(".dialog-button").click();
    await expect(a.locator("body")).toContainText("GitHub");
    await expect(a.locator("body")).toContainText(/\d{3}\s?\d{3}/);
    await until(() => alice.updates()).toBeGreaterThan(0);
    const b = await bob();
    await alice.relayTo(b);
    await expect(b.app.locator("body")).toContainText("GitHub");
    return { sync_verified: true };
});

deep("webxdc-realtime-check", { shared_state: "realtime", tested: "Alice and Bob open it, their realtime data is relayed both ways; each lists the other as a peer with a ping" }, async ({ alice, a, bob }) => {
    const b = await bob();
    await expect.poll(async () => {
        await alice.relayRealtime(b);
        await b.relayRealtime(alice);
        return (await a.locator("tbody tr").count()) > 1 && (await b.app.locator("tbody tr").count()) > 1;
    }, { timeout: 15_000, intervals: [1000] }).toBe(true);
    await expect(a.locator("tbody")).toContainText("Bob");
    await expect(b.app.locator("tbody")).toContainText("Alice");
    return { sync_verified: true };
});

deep("durian-colors", { shared_state: "yes", tested: "Alice generates a random color and saves it, Bob sees it among the saved colors" }, async ({ alice, a, bob }) => {
    await a.locator("#generate").click();
    const hex = (await a.locator(".main-color").innerText()).trim();
    await a.getByRole("button", { name: "Save color" }).click();
    await alice.page.waitForTimeout(500);
    await dump(await alice.frame(), "colors");
    await until(() => alice.updates()).toBeGreaterThan(0);
    const b = await bob();
    await alice.relayTo(b);
    await b.page.waitForTimeout(1000);
    const live = (await b.app.locator("#saved-colors").innerText()).includes(hex);
    // The app re-renders only on its own state changes: any click shows what arrived.
    if (!live) await b.app.locator("#generate").click();
    await expect(b.app.locator("#saved-colors")).toContainText(hex);
    return {
        verdict: live ? "works" : "partial",
        sync_verified: true,
        problems: live ? [] : ["Bob's saved-colors list does not re-render when the update arrives; it shows the color only after his next click"],
        cause: live ? "none" : "app",
        notes: live ? "" : "The update listener (index.js) merges into window.crdt but never triggers the Lua/fengari re-render.",
    };
});

deep("muslim-prayer-times", { shared_state: "no", overlay: true, tested: "Alice opens it and picks the city 'Albania, Tirana'; the prayer times change underneath, but the player's 'Starting…' overlay never goes away" }, async ({ alice, a }) => {
    const cover = overlay(alice.page);
    await expect(a.locator("#city-select")).toBeAttached({ timeout: 15_000 });
    const before = await a.locator("main").innerText();
    await a.locator("#city-select").selectOption("Albania, Tirana");
    await expect.poll(async () => (await a.locator("main").innerText()) !== before).toBe(true);
    await alice.page.waitForTimeout(5000);
    const stuck = await cover.isVisible();
    if (!stuck) return {};
    const text = (await cover.innerText()).trim();
    // Can the user reach the app at all? A real click on the city select lands on the overlay.
    const hit = await alice.page.evaluate(() => {
        const f = document.querySelector("iframe")!.contentDocument;
        return f ? (f.elementFromPoint(450, 400) as HTMLElement | null)?.className ?? "" : "cross-origin";
    });
    return {
        verdict: "broken",
        problems: [`The player overlay "${text}" stays over the app forever: the app does not load webxdc.js, so the runner never sends the "hello" that marks it running. The app itself renders and works underneath (city change updates the table).`],
        cause: "widget",
        notes: `src/bridge.ts sets status "running" only in connect(), on {xdc:"hello"} from runner/shim.js (posted when webxdc.js loads); src/Player.svelte shows .player-stage .overlay while status !== "running". Delta Chat shows apps that never load webxdc.js. Element at the overlay's centre in the widget: "${hit}".`,
    };
});

deep("stbaeumer-meet-up", { shared_state: "no", tested: "Alice fills in a meeting and sends it to the chat; the widget asks, then posts text + .ics file" }, async ({ alice, a }) => {
    await a.locator("#meetingTitle").fill("Team lunch");
    await a.locator("#startDate").fill("2026-11-02");
    await a.locator("#startTime").fill("12:30");
    await a.locator("#submitButton").click();
    await widget(alice.page).getByRole("button", { name: "Send", exact: true }).click();
    await until(async () => (await chats(alice.page)).length).toBeGreaterThan(0);
    const msgs = await chats(alice.page);
    return { notes: `room messages: ${msgs.map((m: any) => `${m.content.msgtype} ${m.content.body?.slice(0, 40)}`).join(" | ")}` };
});

deep("amzd-radio-station", { shared_state: "realtime", tested: "Alice adds an MP3, it is listed and plays; Bob joins over realtime and gets the playlist" }, async ({ alice, a, bob }) => {
    await a.locator("#file-input").setInputFiles("test/e2e/apps/fixtures/tone.mp3");
    await expect(a.locator("#playlist")).toContainText(/Test Tone|tone/i);
    await a.locator("#playlist").getByText("tone.mp3").click();
    await alice.page.waitForTimeout(1500);
    await dump(await alice.frame(), "radio");
    const t = await a.locator("#current-time").innerText();
    const b = await bob();
    await alice.relayTo(b);
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
        await alice.relayRealtime(b);
        await b.relayRealtime(alice);
        await alice.page.waitForTimeout(1000);
        ok = /Test Tone|tone/i.test(await b.app.locator("#playlist").innerText());
    }
    // The song itself follows in chunks over realtime ("NN% — tone.mp3" until complete).
    let pct = "";
    for (let i = 0; i < 20 && ok; i++) {
        await alice.relayRealtime(b);
        await b.relayRealtime(alice);
        await alice.page.waitForTimeout(700);
        pct = (await b.app.locator("#playlist").innerText()).match(/(\d+)%/)?.[1] ?? "done";
        if (pct === "done") break;
    }
    await dump(await b.frame(), "radio-bob");
    return {
        sync_verified: ok && pct === "done",
        verdict: ok && pct === "done" ? "works" : "partial",
        notes: `Alice's playback clock after 1.5 s: ${t}; Bob's download: ${pct}; realtime messages Alice ${(await alice.toDevice()).length}, Bob ${(await b.toDevice()).length}`,
    };
});

// ---------------------------------------------------------------- DOM games

deep("arcanecircle-othello", { shared_state: "yes", tested: "Alice starts a game, Bob joins after relay, the board shows for both" }, async ({ alice, a, bob }) => {
    await a.locator("#join-btn").click();
    await expect(a.locator("#root")).toContainText(/waiting for opponent/i);
    await until(() => alice.updates()).toBeGreaterThan(0);
    const b = await bob();
    await alice.relayTo(b);
    await expect(b.app.locator("#join-btn")).toHaveText("Join Game");
    await b.app.locator("#join-btn").click();
    await until(() => b.updates()).toBeGreaterThan(0);
    await b.relayTo(alice);
    await expect(a.locator("#game")).toContainText("Bob");
    await until(() => alice.updates()).toBeGreaterThan(1);
    await alice.relayTo(b);
    await expect(b.app.locator("#game")).toContainText("Alice");
    const cell = (who: FrameLocator, r: number, c: number) => who.locator(`#board > div:nth-child(${r + 1}) > div:nth-child(${c + 1})`);
    await cell(a, 2, 3).click();
    await alice.page.waitForTimeout(500);
    await alice.relayTo(b);
    await alice.relayRealtime(b);
    await expect(a.locator("#game h3").first()).toContainText("4 : 1");
    await expect(b.app.locator("#game h3").first()).toContainText("4 : 1");
    return { sync_verified: true, shared_state: "yes", notes: "Uses webxdc updates and a realtime channel for moves; both were relayed." };
});

deep("arcanecircle-babeldungeon-en-es", { shared_state: "yes", tested: "Alice starts a session (Easy), reveals the first card's meaning and grades it" }, async ({ alice, a, bob, note }) => {
    await a.getByRole("button", { name: "New Game" }).click();
    await a.getByRole("button", { name: "Spanish" }).click();
    await expect(a.locator("#app")).toContainText("LEVEL");
    await alice.page.waitForTimeout(500);
    await a.locator("#app button:visible").last().click();
    await a.getByRole("button", { name: /Easy/ }).click();
    await expect(a.getByRole("button", { name: "Reveal" })).toBeVisible();
    const before = await a.locator("#app").innerText();
    await a.getByRole("button", { name: "Reveal" }).click();
    await expect.poll(async () => (await a.locator("#app").innerText()) !== before).toBe(true);
    await alice.page.waitForTimeout(500);
    await dump(await alice.frame(), "babel-en");
    await a.locator("#app button:visible").first().click();
    await alice.page.waitForTimeout(1500);
    const second = await bob(ALICE, "Alice");
    const t0 = await second.app.locator("#app").innerText();
    await alice.relayTo(second);
    await second.page.waitForTimeout(1500);
    note(`second Alice device before relay: ${t0.replace(/\s+/g, " ").slice(0, 80)} / after: ${(await second.app.locator("#app").innerText()).replace(/\s+/g, " ").slice(0, 120)}.`);
    // Updates carry the player's own progress (uid = selfAddr): they sync one person's devices.
    await expect(second.app.locator("#app")).toContainText("Reveal");
    return { sync_verified: true, notes: `Updates sent: ${await alice.updates()}. They carry the player's own progress (uid = selfAddr), so sync was checked with a second device of Alice: after relay it jumped from the intro into the same session.` };
});

deep("arcanecircle-babeldungeon-pt-en", { shared_state: "yes", tested: "Alice starts a session (Easy), reveals the first card's meaning and grades it" }, async ({ alice, a, bob, note }) => {
    await a.getByRole("button", { name: "Continue" }).first().click();
    await expect(a.locator("#app")).toContainText("LEVEL");
    await alice.page.waitForTimeout(500);
    await a.locator("#app button:visible").last().click();
    await a.getByRole("button", { name: /Easy/ }).click();
    await expect(a.getByRole("button", { name: "Reveal" })).toBeVisible();
    const before = await a.locator("#app").innerText();
    await a.getByRole("button", { name: "Reveal" }).click();
    await expect.poll(async () => (await a.locator("#app").innerText()) !== before).toBe(true);
    await alice.page.waitForTimeout(500);
    await dump(await alice.frame(), "babel-pt");
    await a.locator("#app button:visible").first().click();
    await alice.page.waitForTimeout(1500);
    const second = await bob(ALICE, "Alice");
    const t0 = await second.app.locator("#app").innerText();
    await alice.relayTo(second);
    await second.page.waitForTimeout(1500);
    note(`second Alice device before relay: ${t0.replace(/\s+/g, " ").slice(0, 80)} / after: ${(await second.app.locator("#app").innerText()).replace(/\s+/g, " ").slice(0, 120)}.`);
    // Updates carry the player's own progress (uid = selfAddr): they sync one person's devices.
    await expect(second.app.locator("#app")).toContainText("Reveal");
    return { sync_verified: true, notes: `Updates sent: ${await alice.updates()}. They carry the player's own progress (uid = selfAddr), so sync was checked with a second device of Alice: after relay it jumped from the intro into the same session.` };
});

deep("arcanecircle-wonster", { shared_state: "yes", tested: "Alice closes the intro and types a guess; Bob opens, gets Alice's word-of-the-day seed after relay" }, async ({ alice, a, bob, note }) => {
    await alice.page.keyboard.press("Escape");
    await expect(a.locator("#root")).not.toHaveAttribute("inert", "");
    await expect(a.getByRole("dialog")).toHaveCount(0);
    await alice.page.waitForTimeout(500);
    await a.locator("#monster").click(); // keys go to the focused frame
    for (const k of "HOUSE") { await alice.page.keyboard.press(k); await alice.page.waitForTimeout(80); }
    await expect(a.locator(".letter-container").first()).toHaveText(/H/i);
    await alice.page.keyboard.press("Enter");
    await alice.page.waitForTimeout(1500);
    const ls = async (p: Person) => JSON.stringify(await (await p.frame()).evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => !/stat|theme|gameState|highContrast/i.test(k)))));
    const seedA = await ls(alice);
    const b = await bob();
    const seedB0 = await ls(b);
    await alice.relayTo(b);
    await b.page.waitForTimeout(1000);
    const seedB = await ls(b);
    const seed = (j: string) => JSON.parse(j).gameSeed;
    expect(seed(seedB)).toBe(seed(seedA));
    return { sync_verified: true, notes: `Shared state is the word-of-the-day seed: Bob first made his own (${seed(seedB0)}), after relay he adopted Alice's older one (${seed(seedA)}).` };
});

const SCORE_NOTE = "Shared state is only the webxdc-score high-score board, sent when a game ends with a new best; not reached in this test.";

deep("arcanecircle-color-lines", { shared_state: "yes", tested: "Alice selects a ball and moves it to an empty cell; the board advances (new balls appear)" }, async ({ alice, a }) => {
    const board = () => a.locator(".grid").evaluate((g) => [...g.children].map((c) => c.className).join(","));
    const before = await board();
    await a.locator(".grid > .ball").first().click();
    await a.locator(".grid > .empty").last().click();
    await expect.poll(board).not.toBe(before);
    await alice.page.waitForTimeout(800);
    const balls = await a.locator(".grid > .ball").count();
    return { notes: `${SCORE_NOTE} Balls on the board after the move: ${balls}.` };
});

deep("arcanecircle-sudoku", { shared_state: "yes", tested: "Alice selects an empty cell and enters a number" }, async ({ a }) => {
    await a.locator("td.game__cell:not(.game__cell--filled)").first().click();
    await a.locator(".status__number").filter({ hasText: "4" }).first().click();
    await expect(a.locator("td.game__cell--userfilled")).toHaveCount(1);
    return { notes: SCORE_NOTE };
});

deep("jloima-mirkutin", { shared_state: "yes", tested: "Alice presses Start and drags the fan; the timer runs" }, async ({ alice, a }) => {
    await a.locator("#btn-start").click();
    const box = (await a.locator("#playfield").boundingBox())!;
    await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await alice.page.mouse.down();
    for (let i = 0; i < 10; i++) await alice.page.mouse.move(box.x + box.width / 2 + (i % 2 ? 40 : -40), box.y + box.height * 0.7, { steps: 5 });
    await alice.page.mouse.up();
    await expect.poll(async () => parseFloat(await a.locator("#hud-timer").innerText())).toBeGreaterThan(1);
    return { notes: "Shared state is a best-time board (sendUpdate on finish); not reached in this test." };
});

// ---------------------------------------------------------------- canvas games

/** The frame's pixels change after the action, and the screen was still before it (so it is not idle animation). */
async function probe(alice: Person, tag: string, act: () => Promise<void>): Promise<boolean> {
    await shot(alice.page, `${tag}.before`);
    const { idle, changed } = await reacts(alice.page, stage(alice.page), act, 1000);
    await shot(alice.page, `${tag}.after`);
    console.log(`${tag}: idle screen ${idle ? "animated" : "still"}, after input ${changed ? "changed" : "same"}`);
    return changed;
}

deep("arcanecircle-bejeweled", { shared_state: "yes", tested: "Alice taps the canvas (start) and drags a gem; the board shows and changes" }, async ({ alice, a }) => {
    const box = (await a.locator("canvas").boundingBox())!;
    const changed = await probe(alice, "bejeweled", async () => {
        await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await alice.page.waitForTimeout(800);
        await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.6);
        await alice.page.mouse.down();
        await alice.page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height * 0.6, { steps: 8 });
        await alice.page.mouse.up();
    });
    expect(changed).toBe(true);
    return { notes: SCORE_NOTE };
});

deep("arcanecircle-forgottendepths", { shared_state: "no", tested: "Alice presses X (A button) on New Game and moves through the menu with the arrow keys; the screen changes to the Catacombs menu" }, async ({ alice, a }) => {
    const box = (await a.locator("canvas").boundingBox())!;
    const changed = await probe(alice, "forgotten", async () => {
        await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.5);
        await hold(alice.page, "x"); // KeyX is the A button: "New Game"
        await alice.page.waitForTimeout(1500);
        for (const k of ["ArrowRight", "ArrowRight", "ArrowDown"]) await hold(alice.page, k);
    });
    expect(changed).toBe(true);
});

deep("arcanecircle-knight-arena", { shared_state: "yes", tested: "Alice holds V to start with the left weapon and presses arrow keys; the arena (level 1) shows" }, async ({ alice, a }) => {
    const box = (await a.locator("#main-menu").boundingBox())!;
    const changed = await probe(alice, "knight", async () => {
        await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await hold(alice.page, "v");
        await alice.page.waitForTimeout(1000);
        for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "Space"]) { await alice.page.keyboard.press(k); await alice.page.waitForTimeout(200); }
    });
    expect(changed).toBe(true);
    return { notes: SCORE_NOTE };
});

deep("arcanecircle-sector13", { shared_state: "yes", tested: "Alice clicks STORY on the title canvas; the sector selection shows" }, async ({ alice, a }) => {
    const box = (await a.locator("canvas#c").boundingBox())!;
    const changed = await probe(alice, "sector13", async () => {
        await alice.page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.57);
        await alice.page.waitForTimeout(800);
        for (const k of ["Enter", "Space", "ArrowUp", "ArrowRight"]) { await alice.page.keyboard.press(k); await alice.page.waitForTimeout(300); }
    });
    expect(changed).toBe(true);
    return { notes: SCORE_NOTE };
});

deep("arcanecircle-tetris", { shared_state: "yes", tested: "Alice presses Play and moves/rotates the falling piece" }, async ({ alice, a }) => {
    const changed = await probe(alice, "tetris", async () => {
        await a.getByText("Play", { exact: true }).click();
        await alice.page.waitForTimeout(500);
        for (const k of ["ArrowLeft", "ArrowUp", "ArrowDown"]) { await alice.page.keyboard.press(k); await alice.page.waitForTimeout(300); }
    });
    expect(changed).toBe(true);
    return { notes: SCORE_NOTE };
});

deep("r10s-pac-1d", { shared_state: "yes", tested: "Alice taps to start and taps to turn; the game state (player, score) changes" }, async ({ alice }) => {
    const f = await alice.frame();
    const state = () => f.evaluate("JSON.stringify({ p: typeof player === 'undefined' || !player ? null : Math.round(player.x), vx: typeof player === 'undefined' || !player ? null : player.vx, score: typeof score === 'undefined' ? null : score })") as Promise<string>;
    const before = await state();
    await alice.page.mouse.click(450, 400);
    await alice.page.waitForTimeout(1000);
    const mid = await state();
    await alice.page.mouse.click(450, 400);
    await alice.page.waitForTimeout(800);
    const after = await state();
    await shot(alice.page, "pac1d.after");
    expect(mid).not.toBe(before);
    return { notes: `Shared state is only the high score (sent at game over with a new best); not reached in this test. Game state before ${before}, after tap ${mid}, after second tap ${after}.` };
});
