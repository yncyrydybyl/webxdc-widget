import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { IRoomEvent } from "matrix-widget-api";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { encryptAttachment } from "./crypto";
import { INSTANCE_TYPE, SYNC_TYPE, UPDATE_TYPE, type InstanceContent } from "./events";
import { resetStorageForTests } from "./log";
import { frame, unframe } from "./realtime";
import { mimeFor } from "./chat";
import { Bucket, Room, rateLimitDelay, sanitizeUpdate, type RoomApi } from "./room";

/** Another device: its own IndexedDB. */
function newDevice(): void {
    globalThis.indexedDB = new IDBFactory();
    resetStorageForTests();
}

let n = 0;
const ev = (type: string, content: unknown, sender = "@bob:x", extra: Partial<IRoomEvent> = {}): IRoomEvent =>
    ({ type, content, sender, event_id: `$e${++n}`, room_id: "!r:x", origin_server_ts: Date.now(), unsigned: {}, ...extra }) as IRoomEvent;

function fakeApi() {
    const sent: { type: string; content: any }[] = [];
    const uploads = new Map<string, Uint8Array>();
    const toDevice: any[] = [];
    let failNext: unknown = null;
    const api: RoomApi = {
        async sendRoomEvent(type, content) {
            if (failNext) {
                const e = failNext;
                failNext = null;
                throw e;
            }
            sent.push({ type, content });
            return { event_id: `$s${sent.length}` };
        },
        async sendStateEvent(type, stateKey, content) {
            sent.push({ type, content: { stateKey, ...(content as object) } });
            return {};
        },
        async readRoomEvents() {
            return [];
        },
        async readStateEvents() {
            return [];
        },
        async uploadFile(file) {
            const uri = `mxc://x/${uploads.size + 1}`;
            uploads.set(uri, new Uint8Array(await new Response(file).arrayBuffer()));
            return { content_uri: uri };
        },
        async downloadFile(uri) {
            return { file: new Blob([uploads.get(uri)! as Uint8Array<ArrayBuffer>]) };
        },
        async sendToDevice(type, encrypted, map) {
            toDevice.push({ type, encrypted, map });
            return {};
        },
    };
    return { api, sent, uploads, toDevice, fail: (e: unknown) => (failNext = e) };
}

const until = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > end) throw new Error("timeout");
        await new Promise((r) => setTimeout(r, 5));
    }
};

const content: InstanceContent = { v: 1, name: "Poll", mxc: "mxc://x/app", sha256: "ab", size: 1 };
const uniq = () => `i${Math.random().toString(16).slice(2)}`;

describe("Room", () => {
    it("applies instance state, and an initial read does not override a push", () => {
        const room = new Room(null, "@me:x");
        room.onState([ev(INSTANCE_TYPE, content, "@me:x", { state_key: "a" })]);
        room.onState([ev(INSTANCE_TYPE, { ...content, name: "Old" }, "@me:x", { state_key: "a" })], true);
        expect(room.instances.get("a")?.content.name).toBe("Poll");
        room.onState([ev(INSTANCE_TYPE, {}, "@me:x", { state_key: "a" })]);
        expect(room.instances.has("a")).toBe(false);
    });

    it("delivers own updates locally first, batches them into one event, and de-duplicates the echo", async () => {
        const { api, sent } = fakeApi();
        const room = new Room(api, "@me:x", null, new Bucket(1, 100));
        const id = uniq();
        const seen: unknown[] = [];
        room.subscribe(id, (e) => seen.push(e.update.payload));
        await room.send(id, { payload: 1 });
        await room.send(id, { payload: 2 });
        await room.send(id, { payload: 3 });
        expect(seen).toEqual([1, 2, 3]);
        await until(() => sent.reduce((k, s) => k + (s.content.updates?.length ?? 0), 0) === 3);
        // The first goes out at once; the bucket is then empty, so 2 and 3 wait and share an event.
        expect(sent.map((s) => s.content.updates.length)).toEqual([1, 2]);
        for (const s of sent) await room.onEvent(ev(UPDATE_TYPE, s.content, "@me:x"));
        expect(seen).toEqual([1, 2, 3]);
        const log = await room.log(id);
        expect(log.entries.map((e) => e.serial)).toEqual([1, 2, 3]);
    });

    it("assigns serials in arrival order and replays after a serial", async () => {
        const room = new Room(null, "@me:x");
        const id = uniq();
        for (const p of ["a", "b", "c"]) await room.onEvent(ev(UPDATE_TYPE, { v: 1, instance: id, updates: [{ id: p, payload: p }] }));
        const log = await room.log(id);
        expect(log.after(1).map((e) => e.update.payload)).toEqual(["b", "c"]);
        expect(log.maxSerial).toBe(3);
    });

    it("drops malformed updates and unknown fields", async () => {
        expect(sanitizeUpdate({ payload: 1, info: "x", evil: 2, notify: { a: "t", b: 3 } } as never)).toEqual({ payload: 1, info: "x", notify: { a: "t" } });
        expect(sanitizeUpdate({ info: "no payload" } as never)).toBeNull();
    });

    it("spills large updates to an encrypted upload and reads them back", async () => {
        const { api, sent, uploads } = fakeApi();
        const room = new Room(api, "@me:x", null, new Bucket(10, 100));
        const id = uniq();
        const big = "x".repeat(60_000);
        await room.send(id, { payload: big });
        await until(() => sent.length === 1);
        expect(sent[0].content.file?.url).toMatch(/^mxc:/);
        expect(sent[0].content.updates).toBeUndefined();
        // The upload is ciphertext.
        expect(new TextDecoder().decode([...uploads.values()][0])).not.toContain("xxxx");
        newDevice();
        const other = new Room(api, "@bob:x");
        await other.onEvent(ev(UPDATE_TYPE, sent[0].content, "@me:x"));
        expect((await other.log(id)).entries[0].update.payload).toBe(big);
    });

    it("refuses updates over sendUpdateMaxSize", async () => {
        const room = new Room(null, "@me:x");
        await expect(room.send(uniq(), { payload: "x".repeat(130_000) })).rejects.toThrow(/limit/);
    });

    it("turns info into a notice and notify into mentions", async () => {
        const { api, sent } = fakeApi();
        const room = new Room(api, "@me:x", null, new Bucket(10, 100));
        const id = uniq();
        room.onState([
            ev(INSTANCE_TYPE, content, "@me:x", { state_key: id }),
            ev("m.room.member", { membership: "join", displayname: "Bob" }, "@bob:x", { state_key: "@bob:x" }),
            ev("m.room.member", { membership: "join" }, "@me:x", { state_key: "@me:x" }),
        ]);
        const bob = await room.addr("@bob:x", id);
        await room.send(id, { payload: 1, info: "Me voted", notify: { [bob]: "Your turn" } });
        await until(() => sent.length === 2);
        const notice = sent.find((s) => s.type === "m.room.message")!.content;
        expect(notice.msgtype).toBe("m.notice");
        expect(notice.body).toBe("Poll: Me voted");
        expect(notice["m.mentions"]).toEqual({ user_ids: ["@bob:x"] });
    });

    it("gives every user a different, stable address per app", async () => {
        const room = new Room(null, "@me:x");
        expect(await room.addr("@a:x", "one")).toBe(await room.addr("@a:x", "one"));
        expect(await room.addr("@a:x", "one")).not.toBe(await room.addr("@a:x", "two"));
        expect(await room.addr("@a:x", "one")).not.toBe(await room.addr("@b:x", "one"));
    });

    it("answers a history request with its log, and a newcomer merges the offer", async () => {
        const id = uniq();
        const a = fakeApi();
        const alice = new Room(a.api, "@alice:x", null, new Bucket(10, 100));
        alice.syncDelay = () => 0;
        alice.onState([ev(INSTANCE_TYPE, content, "@alice:x", { state_key: id })]);
        for (const p of [1, 2, 3]) await alice.onEvent(ev(UPDATE_TYPE, { v: 1, instance: id, updates: [{ id: `u${p}`, payload: p }] }));

        newDevice();
        const b = fakeApi();
        const bob = new Room(b.api, "@bob:x", id, new Bucket(10, 100));
        await bob.requestSync(id);
        await until(() => b.sent.length === 1);
        const request = b.sent[0];
        expect(request.content).toMatchObject({ kind: "request", have: 0 });

        await alice.onEvent(ev(SYNC_TYPE, request.content, "@bob:x"));
        await until(() => a.sent.length === 1);
        const offer = a.sent[0];
        expect(offer.content).toMatchObject({ kind: "offer", count: 3 });

        await bob.onEvent(ev(SYNC_TYPE, offer.content, "@alice:x"));
        const log = await bob.log(id);
        expect(log.entries.map((e) => [e.update.payload, e.sender])).toEqual([
            [1, "@bob:x"],
            [2, "@bob:x"],
            [3, "@bob:x"],
        ]);
        // Alice does not answer the same request twice, nor an old one.
        await alice.onEvent(ev(SYNC_TYPE, request.content, "@bob:x"));
        await alice.onEvent(ev(SYNC_TYPE, { ...request.content, nonce: "old" }, "@bob:x", { origin_server_ts: Date.now() - 10 * 60_000 }));
        await new Promise((r) => setTimeout(r, 30));
        expect(a.sent.length).toBe(1);
    });

    it("does not answer when someone else already did", async () => {
        const id = uniq();
        const a = fakeApi();
        const alice = new Room(a.api, "@alice:x");
        alice.onState([ev(INSTANCE_TYPE, content, "@alice:x", { state_key: id })]);
        await alice.onEvent(ev(UPDATE_TYPE, { v: 1, instance: id, updates: [{ id: "u", payload: 1 }] }));
        alice.syncDelay = () => 50;
        const answering = alice.onEvent(ev(SYNC_TYPE, { v: 1, instance: id, kind: "request", nonce: "n1", have: 0 }, "@bob:x"));
        await alice.onEvent(ev(SYNC_TYPE, { v: 1, instance: id, kind: "offer", nonce: "n1", count: 1, entries: [] }, "@carol:x"));
        await answering;
        expect(a.sent.length).toBe(0);
    });

    it("retries after M_LIMIT_EXCEEDED", async () => {
        const { api, sent, fail } = fakeApi();
        const room = new Room(api, "@me:x", null, new Bucket(10, 100));
        const err = Object.assign(new Error("rate"), { data: { matrix_api_error: { http_status: 429, response: { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 1000 } } } });
        expect(rateLimitDelay(err)).toBe(1000);
        expect(rateLimitDelay(new Error("M_FORBIDDEN"))).toBeNull();
        fail(err);
        await room.send(uniq(), { payload: 1 });
        await until(() => sent.length === 1, 4000);
    });

    it("realtime data goes to members by to-device, and its own data is ignored", async () => {
        const { api, toDevice } = fakeApi();
        const room = new Room(api, "@me:x");
        room.onState([ev("m.room.member", { membership: "join" }, "@bob:x", { state_key: "@bob:x" })]);
        const got: number[][] = [];
        const ch = room.joinRealtime("i", (d) => got.push([...d]));
        ch.send(new Uint8Array([1, 2]));
        await until(() => toDevice.length === 1, 1000);
        // "*" (all devices): clients can only send that unencrypted.
        expect(toDevice[0].encrypted).toBe(false);
        expect(Object.keys(toDevice[0].map)).toEqual(["@bob:x"]);
        const sentContent = toDevice[0].map["@bob:x"]["*"];
        room.onToDevice({ type: toDevice[0].type, sender: "@me:x", content: sentContent });
        expect(got).toEqual([]);
        room.onToDevice({ type: toDevice[0].type, sender: "@bob:x", content: { ...sentContent, peer: "other" } });
        expect(got).toEqual([[1, 2]]);
        // Not a member: dropped (unencrypted to-device can come from anyone).
        room.onToDevice({ type: toDevice[0].type, sender: "@mallory:y", content: { ...sentContent, peer: "m" } });
        ch.leave();
        room.onToDevice({ type: toDevice[0].type, sender: "@bob:x", content: { ...sentContent, peer: "other" } });
        expect(got.length).toBe(1);
    });

    it("realtime batches what an app sends while the host is busy, and loses nothing", async () => {
        const { api } = fakeApi();
        let open = 0;
        let peak = 0;
        const sends: any[] = [];
        api.sendToDevice = async (_type, _enc, map) => {
            open++;
            peak = Math.max(peak, open);
            sends.push(map);
            await new Promise((r) => setTimeout(r, 50)); // Element: one at a time, ~75 ms each
            open--;
            return {};
        };
        const room = new Room(api, "@me:x");
        room.onState([ev("m.room.member", { membership: "join" }, "@bob:x", { state_key: "@bob:x" })]);
        const ch = room.joinRealtime("i", () => undefined);
        for (let i = 0; i < 100; i++) ch.send(new Uint8Array([i]));
        await until(() => open === 0 && sends.length > 0, 2000);
        await new Promise((r) => setTimeout(r, 120));
        expect(peak).toBe(1);
        expect(sends.length).toBeLessThanOrEqual(3);
        // Bob gets all 100, in order.
        const bob = new Room(fakeApi().api, "@bob:x");
        bob.onState([ev("m.room.member", { membership: "join" }, "@me:x", { state_key: "@me:x" })]);
        const got: number[] = [];
        bob.joinRealtime("i", (d) => got.push(d[0]));
        for (const map of sends) bob.onToDevice({ type: "de.datanauten.webxdc.realtime", sender: "@me:x", content: map["@bob:x"]["*"] });
        expect(got).toEqual([...Array(100).keys()]);
    });

    it("delivers a sender's realtime data in the order it arrived, whatever decryption takes", async () => {
        const encryption = ev("m.room.encryption", { algorithm: "m.megolm.v1.aes-sha2" }, "@a:x", { state_key: "" });
        const members = ["@a:x", "@b:x"].map((u) => ev("m.room.member", { membership: "join" }, u, { state_key: u }));
        const A = fakeApi();
        const alice = new Room(A.api, "@a:x");
        const bob = new Room(fakeApi().api, "@b:x");
        for (const r of [alice, bob]) r.onState([encryption, ...members]);
        const ch = alice.joinRealtime("i", () => undefined);
        // One message per to-device event: big and small alternate, so decryption times differ.
        for (let i = 0; i < 20; i++) {
            ch.send(i % 2 ? new Uint8Array(30_000).fill(i) : new Uint8Array([i]));
            await until(() => A.toDevice.length === i + 1, 1000);
        }
        const got: number[] = [];
        bob.joinRealtime("i", (d) => got.push(d[0]));
        const key = A.sent.find((s) => s.content.kind === "rt-key")!;
        await bob.onEvent(ev(key.type, key.content, "@a:x"));
        for (const t of A.toDevice) bob.onToDevice({ type: t.type, sender: "@a:x", content: t.map["@b:x"]["*"] });
        await until(() => got.length === 20, 2000);
        expect(got).toEqual([...Array(20).keys()]);
    });

    it("a page that appears later still gets the others' realtime keys", async () => {
        const encryption = ev("m.room.encryption", { algorithm: "m.megolm.v1.aes-sha2" }, "@a:x", { state_key: "" });
        const members = ["@a:x", "@b:x"].map((u) => ev("m.room.member", { membership: "join" }, u, { state_key: u }));
        const A = fakeApi();
        const B = fakeApi();
        const alice = new Room(A.api, "@a:x");
        const bob = new Room(B.api, "@b:x");
        for (const r of [alice, bob]) r.onState([encryption, ...members]);
        // Bob was first; his announcement went out before Alice's widget ran, and she never saw it.
        bob.joinRealtime("i", () => undefined);
        await until(() => B.sent.some((s) => s.content.kind === "rt-key"), 2000);
        alice.joinRealtime("i", () => undefined);
        await until(() => A.sent.some((s) => s.content.kind === "rt-key"), 2000);
        const aliceKey = A.sent.find((s) => s.content.kind === "rt-key")!;
        await bob.onEvent(ev(aliceKey.type, aliceKey.content, "@a:x"));
        // Bob answers the newcomer with his key at once.
        await until(() => B.sent.filter((s) => s.content.kind === "rt-key").length === 2, 2000);
    });

    it("hands an app what came over realtime shortly before it joined", async () => {
        const { api, toDevice } = fakeApi();
        const alice = new Room(api, "@a:x");
        const bob = new Room(fakeApi().api, "@b:x");
        const members = ["@a:x", "@b:x"].map((u) => ev("m.room.member", { membership: "join" }, u, { state_key: u }));
        for (const r of [alice, bob]) r.onState(members);
        alice.joinRealtime("i", () => undefined).send(new Uint8Array([42]));
        await until(() => toDevice.length === 1, 1000);
        // Bob's app is still starting when Alice's state arrives.
        bob.onToDevice({ type: toDevice[0].type, sender: "@a:x", content: toDevice[0].map["@b:x"]["*"] });
        const got: number[] = [];
        bob.joinRealtime("i", (d) => got.push(d[0]));
        expect(got).toEqual([42]);
    });

    it("sends a 128 kB realtime message in parts and puts it together again", async () => {
        const encryption = ev("m.room.encryption", { algorithm: "m.megolm.v1.aes-sha2" }, "@a:x", { state_key: "" });
        const members = ["@a:x", "@b:x"].map((u) => ev("m.room.member", { membership: "join" }, u, { state_key: u }));
        const A = fakeApi();
        const alice = new Room(A.api, "@a:x");
        const bob = new Room(fakeApi().api, "@b:x");
        for (const r of [alice, bob]) r.onState([encryption, ...members]);
        const song = new Uint8Array(128_000).map((_, i) => i % 251);
        const ch = alice.joinRealtime("i", () => undefined);
        ch.send(new Uint8Array([1]));
        ch.send(song);
        ch.send(new Uint8Array([2]));
        await until(() => A.toDevice.length >= 6, 2000);
        // Every to-device message stays well under the server's 64 KiB.
        for (const t of A.toDevice) expect(JSON.stringify(t.map["@b:x"]["*"]).length).toBeLessThan(60_000);
        const got: Uint8Array[] = [];
        bob.joinRealtime("i", (d) => got.push(d));
        const key = A.sent.find((s) => s.content.kind === "rt-key")!;
        await bob.onEvent(ev(key.type, key.content, "@a:x"));
        for (const t of A.toDevice) bob.onToDevice({ type: t.type, sender: "@a:x", content: t.map["@b:x"]["*"] });
        await until(() => got.length === 3, 2000);
        expect(got.map((g) => g.length)).toEqual([1, 128_000, 1]);
        expect(got[1]).toEqual(song);
    });

    it("frames and unframes realtime batches", () => {
        const parts = [new Uint8Array([]), new Uint8Array([1, 2, 3]), new Uint8Array(70_000).fill(7)];
        expect(unframe(frame(parts)).map((p) => p.length)).toEqual([0, 3, 70_000]);
    });

    it("realtime data in an encrypted room is encrypted with a key that travels in the timeline", async () => {
        const encryption = ev("m.room.encryption", { algorithm: "m.megolm.v1.aes-sha2" }, "@a:x", { state_key: "" });
        const members = ["@a:x", "@b:x"].map((u) => ev("m.room.member", { membership: "join" }, u, { state_key: u }));
        const A = fakeApi();
        const B = fakeApi();
        const alice = new Room(A.api, "@a:x");
        const bob = new Room(B.api, "@b:x");
        for (const r of [alice, bob]) r.onState([encryption, ...members]);
        const got: number[][] = [];
        alice.joinRealtime("i", () => undefined).send(new Uint8Array([7, 8, 9]));
        bob.joinRealtime("i", (d) => got.push([...d]));
        await until(() => A.toDevice.length === 1 && A.sent.some((s) => s.content.kind === "rt-key"), 4000);
        const data = A.toDevice[0].map["@b:x"]["*"];
        expect(A.toDevice[0].encrypted).toBe(false);
        expect(data.data).toBeUndefined();
        expect(typeof data.ct).toBe("string");
        // The data may arrive before the key: Bob holds it until the key event comes.
        bob.onToDevice({ type: A.toDevice[0].type, sender: "@a:x", content: data });
        expect(got).toEqual([]);
        const key = A.sent.find((s) => s.content.kind === "rt-key")!;
        await bob.onEvent(ev(key.type, key.content, "@a:x"));
        await until(() => got.length === 1, 1000);
        expect(got).toEqual([[7, 8, 9]]);
        // Plain data is refused in an encrypted room.
        bob.onToDevice({ type: A.toDevice[0].type, sender: "@a:x", content: { instance: "i", peer: "p2", data: "AQI=" } });
        expect(got.length).toBe(1);
    });

    it("sendToChat encrypts files in an encrypted room", async () => {
        const { api, sent, uploads } = fakeApi();
        const room = new Room(api, "@me:x");
        room.onState([ev("m.room.encryption", { algorithm: "m.megolm.v1.aes-sha2" }, "@me:x", { state_key: "" })]);
        await room.sendToChat({ text: "hi", file: { name: "a.txt", blob: new Blob(["secret text"], { type: "text/plain" }) } });
        expect(sent[0].content.msgtype).toBe("m.file");
        expect(sent[0].content.file.key.alg).toBe("A256CTR");
        expect(sent[0].content.url).toBeUndefined();
        expect(new TextDecoder().decode([...uploads.values()][0])).not.toContain("secret");
        expect(sent[1].content).toEqual({ msgtype: "m.text", body: "hi" });
    });
});

describe("sendToChat files", () => {
    it("sends a picture as m.image with a real MIME type when the app says only \"image\"", async () => {
        const { api, sent } = fakeApi();
        const room = new Room(api, "@me:x");
        await room.sendToChat({ file: { name: "card.jpeg", blob: new Blob([new Uint8Array([0xff, 0xd8])]), type: "image" } });
        expect(sent[0].content.msgtype).toBe("m.image");
        expect(sent[0].content.info.mimetype).toBe("image/jpeg");
    });

    it("guesses from the name only when the type is not type/subtype", () => {
        expect(mimeFor("a.ics", "text/calendar")).toBe("text/calendar");
        expect(mimeFor("a.ics", "")).toBe("text/calendar");
        expect(mimeFor("notes", "file")).toBe("application/octet-stream");
        expect(mimeFor("x.PNG", "application/octet-stream")).toBe("image/png");
    });

    it("lists an .xdc an app makes as an app in the room, not as a file", async () => {
        const { api, sent } = fakeApi();
        const room = new Room(api, "@me:x");
        const xdc = zipSync({ "index.html": strToU8("<p>hi</p>"), "manifest.toml": strToU8('name = "Made"') }) as Uint8Array<ArrayBuffer>;
        await room.sendToChat({ text: "made for you", file: { name: "Made.xdc", blob: new Blob([xdc]) } });
        expect(sent.find((s) => s.type === INSTANCE_TYPE)?.content.name).toBe("Made");
        expect(sent.some((s) => s.type === "m.room.message" && s.content.msgtype === "m.file")).toBe(false);
        expect(sent.at(-1)?.content).toEqual({ msgtype: "m.text", body: "made for you" });
    });

    it("sends a broken .xdc as a plain file", async () => {
        const { api, sent } = fakeApi();
        const room = new Room(api, "@me:x");
        await room.sendToChat({ file: { name: "broken.xdc", blob: new Blob(["not a zip"]) } });
        expect(sent[0].content.msgtype).toBe("m.file");
        expect(sent[0].content.info.mimetype).toBe("application/x-webxdc");
    });
});

describe("crypto", () => {
    it("round-trips an attachment", async () => {
        const { decryptAttachment } = await import("./crypto");
        const { data, info } = await encryptAttachment(new TextEncoder().encode("hello") as Uint8Array<ArrayBuffer>);
        expect(new TextDecoder().decode(await decryptAttachment(data, { url: "mxc://x/1", ...info }))).toBe("hello");
        data[0] ^= 1;
        await expect(decryptAttachment(data, { url: "mxc://x/1", ...info })).rejects.toThrow(/hash/);
    });
});
