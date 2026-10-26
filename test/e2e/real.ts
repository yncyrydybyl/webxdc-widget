/*
 * Helpers for tests with real apps from the webxdc.org catalog: a mock host per
 * person, the widget and app frames, adding an app through the catalog UI.
 */
import type { Browser, Page } from "@playwright/test";

export const NS = "de.datanauten.webxdc";
export const ROOM = "!room:example.org";
export type W = Window & Record<string, any>;

const members = [
    { type: "m.room.member", state_key: "@alice:example.org", content: { membership: "join", displayname: "Alice" }, sender: "@alice:example.org", event_id: "$m1", room_id: ROOM, origin_server_ts: 1, unsigned: {} },
    { type: "m.room.member", state_key: "@bob:example.org", content: { membership: "join", displayname: "Bob" }, sender: "@bob:example.org", event_id: "$m2", room_id: ROOM, origin_server_ts: 1, unsigned: {} },
];

/** WIDGET_URL: the deployed widget instead of the local build (the host stays local). */
export async function host(browser: Browser, user: string, name: string, fixture: Record<string, unknown> = {}, onPage?: (page: Page) => void): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 900, height: 760 } });
    const page = await context.newPage();
    onPage?.(page);
    await page.addInitScript((f) => ((window as W).__TEST_FIXTURE__ = f), {
        params: { matrix_user_id: user, matrix_display_name: name },
        state: members,
        ...(process.env.WIDGET_URL ? { widgetPath: process.env.WIDGET_URL } : {}),
        ...fixture,
    });
    await page.goto("/__test__/index.html");
    return page;
}

export const widget = (page: Page) => page.frameLocator("iframe");
export const app = (page: Page) => widget(page).frameLocator("iframe");

/** Logs what goes wrong in the page and its frames, for debugging real apps. */
export function logProblems(page: Page): void {
    page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.log(`  [console ${m.type()}] ${m.text().slice(0, 300)}`));
    page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));
    page.on("requestfailed", (r) => console.log(`  [failed] ${r.url()} ${r.failure()?.errorText}`));
    page.on("response", (r) => r.status() >= 400 && console.log(`  [${r.status()}] ${r.url()}`));
}

export async function addFromCatalog(page: Page, search: string, pick: RegExp): Promise<void> {
    await widget(page).getByRole("button", { name: "Add app" }).click();
    await widget(page).getByRole("searchbox", { name: "Search apps" }).fill(search);
    await widget(page).getByRole("button", { name: pick }).first().click();
    await widget(page).getByRole("button", { name: "Add to room" }).click({ timeout: 20_000 });
}

/** Everything `from` sent so far, as the other person's client would receive it. */
export async function relay(from: Page, to: Page, sender: string, skip = 0): Promise<number> {
    const sent = await from.evaluate(() => (window as W).__SENT__);
    const events = sent.slice(skip).filter((s: any) => s.type !== `${NS}.instance` && s.type !== "m.room.message");
    for (const [i, s] of events.entries()) {
        await to.evaluate(([e]) => (window as W).__toWidget("send_event", e), [
            { type: s.type, content: s.content, sender, event_id: `$relay-${skip}-${i}`, room_id: ROOM, origin_server_ts: Date.now() },
        ]);
    }
    return sent.length;
}

/** Bob's room: Alice's instance state and the uploaded .xdc. */
export async function roomOf(alice: Page): Promise<Record<string, unknown>> {
    const sent = await alice.evaluate(() => (window as W).__SENT__);
    const inst = sent.find((s: any) => s.type === `${NS}.instance`);
    const uploads: string[] = await alice.evaluate(() => (window as W).__UPLOADS__.map((u: Uint8Array) => btoa(Array.from(u, (b) => String.fromCharCode(b)).join(""))));
    const { stateKey, ...content } = inst.content;
    const bodies = Object.fromEntries(uploads.map((b64, i) => [`mxc://example.org/uploaded-${i + 1}`, b64]));
    return {
        state: [
            { type: `${NS}.instance`, state_key: stateKey ?? inst.state_key, content, sender: "@alice:example.org", event_id: "$inst", room_id: ROOM, origin_server_ts: Date.now(), unsigned: {} },
            ...members,
        ],
        bodies,
    };
}
