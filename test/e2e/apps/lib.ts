/*
 * Shared pieces of the per-app specs (slice-*.spec.ts): the catalog, the
 * result each app's test writes, starting an app for Alice and Bob in the mock
 * host, delivering realtime data, and input that games notice (held presses,
 * drags), plus a few ways to see whether a canvas reacted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Frame, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { app, host, NS, roomOf, widget, type W } from "../real";

export const ALL = "test/real/all";
export const XDC = `${ALL}/xdc`;
export const DEEP = `${ALL}/deep`;
export const ALICE = "@alice:example.org";
export const BOB = "@bob:example.org";

/** SHOTS=<dir>: screenshots while debugging; nothing is written without it. */
export const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
export const shot = async (page: Page, name: string): Promise<void> => {
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {});
};

// ---- Catalog and results --------------------------------------------------

export const catalog: { app_id: string; name: string }[] = existsSync(`${ALL}/catalog.json`) ? JSON.parse(readFileSync(`${ALL}/catalog.json`, "utf8")) : [];
export const nameOf = (id: string): string => catalog.find((a) => a.app_id === id)?.name ?? id;
export const hasXdc = (id: string): boolean => existsSync(`${XDC}/${id}.xdc`);

export type Verdict = "works" | "partial" | "broken" | "untestable";
export type Cause = "none" | "app" | "widget" | "runner" | "browser" | "test-harness";
export type Result = {
    id: string;
    name: string;
    verdict: Verdict;
    shared_state: "yes" | "no" | "realtime" | "unknown";
    sync_verified: boolean | null;
    tested: string;
    problems: string[];
    cause: Cause;
    notes: string;
};

/** A result with every field present; `defaults` wins over the blanks. */
export const newResult = (id: string, defaults: Partial<Result> = {}): Result => ({
    id,
    name: nameOf(id),
    verdict: "broken",
    shared_state: "unknown",
    sync_verified: null,
    tested: "",
    problems: [],
    cause: "none",
    notes: "",
    ...defaults,
});

export function saveResult(r: Result): void {
    mkdirSync(DEEP, { recursive: true });
    writeFileSync(`${DEEP}/${r.id}.json`, JSON.stringify(r, null, 1) + "\n");
}

/** The first line of an error, short enough for a result. */
export const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 300);

// ---- What goes wrong in a page --------------------------------------------

export type Log = { errors: string[]; blocked: string[] };

/** Page errors, console errors and failed requests of a page and all its frames; CSP refusals apart. */
export function watch(page: Page, who = ""): Log {
    const tag = who ? `${who}: ` : "";
    const log: Log = { errors: [], blocked: [] };
    page.on("pageerror", (e) => log.errors.push(`${tag}pageerror: ${e.message.slice(0, 300)}`));
    page.on("console", (m) => {
        const text = m.text().slice(0, 300);
        if (/Content.Security.Policy|Refused to/i.test(text)) log.blocked.push(`${tag}${text}`);
        else if (m.type() === "error" && !/Failed to load resource/.test(text)) log.errors.push(`${tag}${text}`);
    });
    page.on("response", (r) => r.status() >= 400 && log.errors.push(`${tag}HTTP ${r.status()} ${r.url().replace(/\/app\/[0-9a-f]+\//, "/app/<key>/").slice(0, 200)}`));
    return log;
}

// ---- Starting an app --------------------------------------------------------

/** The app's document in the runner frame (by its URL under /app/<key>/). */
export async function appFrame(page: Page, timeout = 30_000): Promise<Frame> {
    let frame: Frame | undefined;
    await expect.poll(() => (frame = page.frames().find((f) => /\/app\/[^/]+\//.test(f.url()))), { timeout }).toBeTruthy();
    return frame!;
}

/** The app's frame whatever its URL (some apps rewrite it): the child of the widget's player frame. */
export const appFrameAny = async (page: Page): Promise<Frame> => (await (await widget(page).locator(".player-stage iframe").elementHandle())!.contentFrame())!;

export const overlay = (page: Page): Locator => widget(page).locator(".player-stage .overlay");
/** Whether the Player's "Starting…" cover is still over the app. */
export const covered = async (page: Page): Promise<boolean> => (await overlay(page).count()) > 0;
/** Hides the cover (display only), to see whether the app runs underneath; nothing to do when it is gone. */
export const uncover = async (page: Page): Promise<void> => {
    if (await covered(page)) await overlay(page).evaluate((e) => void ((e as HTMLElement).style.display = "none"));
};

/**
 * Alice adds the .xdc through the File tab and starts it; the app's page first
 * (the Player may not have mounted yet), then, with `running`, the cover gone.
 */
export async function addXdc(page: Page, id: string, running = true): Promise<Frame> {
    await widget(page).getByRole("button", { name: "Add app" }).click();
    await widget(page).getByRole("tab", { name: "File" }).click();
    await widget(page).locator('input[type="file"]').setInputFiles(`${XDC}/${id}.xdc`);
    await widget(page).getByRole("button", { name: "Add to room" }).click({ timeout: 20_000 });
    const frame = await appFrame(page);
    await frame.waitForLoadState("load").catch(() => {});
    if (running) await expect(overlay(page)).toHaveCount(0, { timeout: 30_000 });
    return frame;
}

export type Peer = { page: Page; frame: Frame; app: FrameLocator };

/**
 * Another device in the room (Bob, or a second device of Alice): the room has Alice's app; it
 * starts it. `onPage` sees the page before anything loads (to `watch` it from the first request).
 */
export async function startPeer(alice: Page, user = BOB, name = "Bob", running = true, onPage?: (page: Page) => void): Promise<Peer> {
    const page = await host(alice.context().browser()!, user, name, await roomOf(alice), onPage);
    await widget(page).getByRole("button", { name: "Start" }).click();
    const frame = await appFrame(page);
    await frame.waitForLoadState("load").catch(() => {});
    if (running) await expect(overlay(page)).toHaveCount(0, { timeout: 30_000 });
    return { page, frame, app: app(page) };
}

// ---- What the widget sent -------------------------------------------------

export const sent = (page: Page): Promise<any[]> => page.evaluate(() => (window as W).__SENT__ ?? []);
export const updates = async (page: Page): Promise<any[]> => (await sent(page)).filter((s: any) => s.type === `${NS}.update`);
export const chats = async (page: Page): Promise<any[]> => (await sent(page)).filter((s: any) => s.type === "m.room.message");
export const toDevice = (page: Page): Promise<any[]> => page.evaluate(() => (window as W).__TO_DEVICE__ ?? []);

/** Realtime data `from` sent as to-device messages since `skip`, delivered to `to` as the homeserver would (once per message). */
export async function relayRealtime(from: Page, to: Page, sender: string, skip = 0): Promise<number> {
    const all = await toDevice(from);
    for (const m of all.slice(skip)) {
        const byUser: Record<string, Record<string, unknown>> = m.messages ?? m.contentMap ?? {};
        const content = Object.entries(byUser).find(([u]) => u !== sender)?.[1]?.["*"] ?? Object.values(byUser).flatMap((d) => Object.values(d))[0];
        if (content) await to.evaluate(([e]) => (window as W).__toWidget("send_to_device", e), [{ type: m.type ?? m.eventType, sender, encrypted: !!m.encrypted, content }]);
    }
    return all.length;
}

// ---- Input games notice ----------------------------------------------------

/** A press held like a finger at a point of an element (fractions of its box); games read the button per frame. */
export async function press(page: Page, loc: Locator, fx = 0.5, fy = 0.5, ms = 120): Promise<void> {
    const box = (await loc.boundingBox())!;
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
}

/** The same on the whole app frame. */
export const pressFrame = (page: Page, fx = 0.5, fy = 0.5, ms = 120): Promise<void> => press(page, widget(page).locator("iframe"), fx, fy, ms);

export async function hold(page: Page, key: string, ms = 300): Promise<void> {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
}

/** A drag across an element, in steps, like a finger. */
export async function drag(page: Page, loc: Locator, from: [number, number], to: [number, number], steps = 12): Promise<void> {
    const box = (await loc.boundingBox())!;
    await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps });
    await page.mouse.up();
}

// ---- Did it react? ----------------------------------------------------------

/** The visible pixels of the app frame. */
export const stage = (page: Page): Locator => widget(page).locator(".player-stage iframe");

/** Whether `loc` looks different after `act` (and whether it was already moving on its own). */
export async function reacts(page: Page, loc: Locator, act: () => Promise<void>, settle = 800): Promise<{ idle: boolean; changed: boolean }> {
    const a = await loc.screenshot();
    await page.waitForTimeout(400);
    const b = await loc.screenshot();
    await act();
    await page.waitForTimeout(settle);
    const c = await loc.screenshot();
    return { idle: !a.equals(b), changed: !b.equals(c) };
}

export const until = <T>(fn: () => T | Promise<T>, timeout = 8000) => expect.poll(fn, { timeout });

/** The visible text of a frame. */
export const text = (frame: Frame): Promise<string> => frame.evaluate(() => document.body?.innerText ?? "");

/** The visible controls and text of a frame, for finding the way in an unknown UI. */
export async function dump(frame: Frame, tag = ""): Promise<void> {
    const els = await frame.evaluate(() =>
        [...document.querySelectorAll("button, input, textarea, select, a, [contenteditable], [role=button]")]
            .filter((e) => (e as HTMLElement).offsetParent !== null)
            .slice(0, 50)
            .map((e) => `${e.tagName.toLowerCase()}#${e.id}.${String((e as HTMLElement).className).slice(0, 30)} [${(e as HTMLInputElement).type ?? ""}] "${((e as HTMLElement).innerText || (e as HTMLInputElement).placeholder || (e as HTMLInputElement).value || "").trim().slice(0, 40)}"`),
    );
    console.log(`--- ${tag}\n${els.join("\n")}\n--- text: ${(await frame.evaluate(() => document.body.innerText)).slice(0, 600)}`);
}
