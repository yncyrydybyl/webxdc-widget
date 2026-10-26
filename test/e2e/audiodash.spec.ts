/*
 * Audio Dash from the webxdc.org catalog (network): a canvas game that makes its
 * song in the page (data:audio/wav), decodes it with XHR + Web Audio, plays an
 * <audio>, takes the player's own song through a file input (blob:) and keeps
 * best times in localStorage. Run with NETWORK=1; with WIDGET_URL against the
 * deployed widget and runner.
 *
 * Its buttons are drawn on the canvas; the hidden #uiScenes copy is for screen
 * readers, so the test clicks the canvas and reads state from the game's globals.
 */
import { expect, test, type Frame, type Page } from "@playwright/test";
import { addFromCatalog, app, host, logProblems, widget } from "./real";

test.skip(!process.env.NETWORK, "needs the network: NETWORK=1");

/** The app's document in the runner frame, for reading the game's globals. */
async function appFrame(page: Page): Promise<Frame> {
    let frame: Frame | undefined;
    await expect.poll(() => (frame = page.frames().find((f) => /\/app\/[^/]+\/index\.html/.test(f.url())))).toBeTruthy();
    return frame!;
}

type Game = { scene: string; song: string; duration: number; time: number; playing: boolean; best: string };
// A string, not a function: index.js keeps its state in top-level `let`s, which
// only code in the global scope can see.
const game = (frame: Frame): Promise<Game> =>
    frame.evaluate(`({
        scene: [...document.querySelectorAll("#uiScenes > div:not([hidden])")].map((d) => d.textContent).join(" | "),
        song: songName,
        duration: typeof buffer === "undefined" || !buffer ? 0 : buffer.duration,
        time: audio ? audio.currentTime : 0,
        playing: !!audio && !audio.paused,
        best: bestTime,
    })`);

/**
 * A press on the middle of the canvas, held like a finger: the game reads the
 * button once per frame, so an instant click would go unnoticed. The canvas has
 * .wrapper:after on top, as for a real click; the game listens on window.
 */
async function tap(page: Page, ms = 150): Promise<void> {
    const box = (await app(page).locator("canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
}

/**
 * Keeps the ship near the middle (hold = up, release = down) until the song has
 * played for `seconds` or the ship crashes. Unsteered, it crashes in the frame
 * the song would start.
 */
async function steer(page: Page, frame: Frame, seconds: number): Promise<void> {
    const box = (await app(page).locator("canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    let down = false;
    for (let i = 0; i < 400; i++) {
        const s = (await frame.evaluate("({ y: ship.y, mid, time: audio.currentTime, over: gameOverScene.active || winScene.active })")) as { y: number; mid: number; time: number; over: boolean };
        if (s.over || s.time >= seconds) break;
        if (s.y > s.mid && !down) await page.mouse.down();
        if (s.y <= s.mid && down) await page.mouse.up();
        down = s.y > s.mid;
        await page.waitForTimeout(30);
    }
    if (down) await page.mouse.up();
}

/** A 2 s, 440 Hz mono WAV: the player's "own song". */
function toneWav(seconds = 2, rate = 8000): Buffer {
    const n = seconds * rate;
    const b = Buffer.alloc(44 + n * 2);
    b.write("RIFF", 0);
    b.writeUInt32LE(36 + n * 2, 4);
    b.write("WAVEfmt ", 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); // PCM
    b.writeUInt16LE(1, 22); // mono
    b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * 2, 28);
    b.writeUInt16LE(2, 32);
    b.writeUInt16LE(16, 34);
    b.write("data", 36);
    b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000 * (1 - i / n)), 44 + i * 2);
    return b;
}

test("Audio Dash: generated song, playing, best time, own song", async ({ browser }) => {
    test.setTimeout(150_000);
    const alice = await host(browser, "@alice:example.org", "Alice");
    logProblems(alice);
    const blocked: string[] = [];
    alice.on("console", (m) => /Content.Security.Policy|Refused to/i.test(m.text()) && blocked.push(m.text()));

    await addFromCatalog(alice, "audio dash", /^Audio Dash\b/);
    await expect(widget(alice).locator(".player-stage .overlay")).toHaveCount(0, { timeout: 20_000 });
    let frame = await appFrame(alice);

    // The song is generated and decoded in the page, then the menu shows.
    await expect.poll(async () => (await game(frame)).scene, { timeout: 60_000 }).toContain("START");
    const ready = await game(frame);
    expect(ready.song).toBe("AudioDashDefault.mp3");
    expect(ready.duration).toBeGreaterThan(10);
    expect(ready.best).toBe("0:00");
    await alice.screenshot({ path: "test/real/audiodash-menu.png" });

    // START sits in the middle of the canvas. The press is the user gesture audio needs.
    await tap(alice);
    await expect.poll(async () => (await game(frame)).scene).toMatch(/Tap or Hold/i);
    await tap(alice); // the tutorial waits for a first tap
    await steer(alice, frame, 2);
    expect((await game(frame)).time).toBeGreaterThan(0.3);
    await alice.screenshot({ path: "test/real/audiodash-playing.png" });

    // Nobody steers: the ship crashes, and the time counts as the best one.
    await expect.poll(async () => (await game(frame)).scene, { timeout: 60_000 }).toMatch(/GAME OVER|SONG COMPLETED/);
    const over = await game(frame);
    expect(over.playing).toBe(false);
    expect(over.best).not.toBe("0:00");
    await alice.screenshot({ path: "test/real/audiodash-over.png" });

    // Started again, the app still has its best time: storage survives the frame.
    await widget(alice).getByRole("button", { name: "Back to the room's apps" }).click();
    await widget(alice).getByRole("button", { name: "Start" }).click();
    frame = await appFrame(alice);
    await expect.poll(async () => (await game(frame)).scene, { timeout: 60_000 }).toContain("START");
    expect((await game(frame)).best).toBe(over.best);

    // The player's own song: file input, blob: URL, decoded, and the game starts with it.
    await app(alice).locator("#uploadFile").setInputFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: toneWav() });
    await expect.poll(async () => (await game(frame)).song, { timeout: 20_000 }).toBe("tone.wav");
    await expect.poll(async () => Math.round((await game(frame)).duration * 10) / 10, { timeout: 20_000 }).toBe(2); // decoded
    await expect.poll(async () => (await game(frame)).scene).toMatch(/Tap or Hold/i); // the upload starts the game
    await tap(alice);
    await steer(alice, frame, 0.5);
    expect((await game(frame)).time).toBeGreaterThan(0.1);
    await alice.screenshot({ path: "test/real/audiodash-own-song.png" });

    expect(blocked).toEqual([]);
});
