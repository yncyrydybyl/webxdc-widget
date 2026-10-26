# webxdc in Matrix rooms: plan

## What webxdc is

A webxdc app is a zip file (`.xdc`) with an `index.html`, optional `manifest.toml` (`name`,
`source_code_url`) and `icon.png`/`icon.jpg`. Delta Chat, Cheogram and others send it as a chat
attachment, and every member runs their own copy. The copies have **no network access**. They
share state only through the messenger, via `window.webxdc` (served as `webxdc.js` by the
messenger):

| API | Meaning |
|---|---|
| `selfAddr`, `selfName` | stable per-user, per-app id; display name |
| `isAppSender`, `isBroadcast` | did I share the app; broadcast chat |
| `sendUpdate({payload, info, summary, document, href, notify})` | append an update to the app's log, for everyone |
| `setUpdateListener(cb, serial)` | replay every update after `serial`, then live ones; `serial` and `max_serial` on each |
| `sendToChat({file, text})` | prepare a chat message from the app |
| `importFiles(filter)` | file picker |
| `joinRealtimeChannel()` | ephemeral bytes to whoever is connected (experimental) |
| `sendUpdateInterval`, `sendUpdateMaxSize` | limits the messenger announces |

Requirements on the messenger: serve every file from the zip, deny **all** internet access,
isolate storage per app instance, support `localStorage`/`IndexedDB`, relative links, `mailto:`,
file inputs, and confirm with the full URL before opening any external link.

There are roughly 170 public apps (games, polls, editors, calendars, checklists, maps) in the
catalog that `webxdc.org/apps` shows. It is a plain JSON file,
`https://apps.testrun.org/xdcget-lock.json` (name, description, category, `cache_relname` of the
`.xdc`, `icon_relname`), served with `Access-Control-Allow-Origin: *`.

## How it maps onto Matrix

| webxdc | Matrix |
|---|---|
| app shared in a chat | `.xdc` uploaded to the media repo, plus one **room state event** `de.datanauten.webxdc.instance`, state key = instance id, with name, `mxc`, sha256, size, icon `mxc`, who added it |
| `sendUpdate` | **timeline event** `de.datanauten.webxdc.update` `{instance, updates: [...]}`, encrypted in E2EE rooms; several queued updates go out as one event |
| update `serial` | a local counter, assigned the first time this device sees an update and kept in IndexedDB, so it stays stable across reloads |
| `selfAddr` | `sha256(user id + instance id)`, so the same person has a different address in every app |
| `selfName` | the Matrix display name (`$matrix_display_name`), else the localpart |
| `isAppSender` | I sent the instance state event |
| `info` | an `m.notice` in the room ("Chess: Alice moved"), rate-limited |
| `notify` | the same `m.notice` with `m.mentions` for the users the addresses belong to |
| `sendToChat` | after the user confirms it in the widget, an `m.text`/`m.file`/`m.image` message; files are encrypted in-widget in E2EE rooms |
| `importFiles` | the browser's file picker inside the app frame |
| `joinRealtimeChannel` | to-device messages (MSC3819) to all devices of the room's joined members, the payload encrypted by the widget; see "Realtime" below |
| history for latecomers | **peer sync**: a newcomer sends `de.datanauten.webxdc.sync` `{request}`, one open peer answers with the log (inline, or as an encrypted upload whose key travels in the encrypted event) |

### Realtime

Implemented in `src/realtime.ts`; event formats in `src/events.ts` (`RealtimeContent`,
`SyncKeyContent`). The shape comes from what Element does, found by recording apps with two
Element clients (0.1.2–0.1.5):

- **To all devices, unencrypted transport.** Each message goes as a to-device event
  `de.datanauten.webxdc.realtime` to `"*"` (every device) of every joined member, at most 50.
  Clients cannot encrypt a to-device message for `"*"` (Element: "encryptToDeviceMessages:
  unknown device"), and a widget cannot list devices, so the event itself is not encrypted.
  Unencrypted to-device events can come from anyone, so only senders who are room members count.
- **Payload encryption in encrypted rooms.** Each page (one widget load) makes an AES-GCM-256
  key and announces it as a sync event `{kind: "rt-key", instance, nonce: <peer id>, key}` in
  the room's timeline, which is end-to-end encrypted. Data carries `{instance, peer, iv, ct}`;
  the instance id is the additional data. Plain `data` is refused in encrypted rooms. A page
  that sees a key from a page it does not know announces its own again (a newcomer may have
  missed it: a widget reads back only part of the timeline); several newcomers within 2 s
  share one announcement.
- **Batching.** Element sends a widget's to-device messages one at a time (~75 ms each); apps
  send up to ~30 messages a second (cursors). What an app sends while a message is in flight
  goes into the next one: `batch: 1`, the payload is each message as a 4-byte big-endian length
  and its bytes, up to 40 kB. Past 256 waiting messages the oldest are dropped (realtime is
  ephemeral by spec).
- **Parts.** webxdc allows 128 kB per message; a to-device event holds about 64 KiB of JSON.
  A message over 40 kB goes as up to 8 parts `part: {id, i, n}`, each its own event, put
  together on arrival (dropped after 60 s if incomplete).
- **Order and early data.** Decryption is asynchronous; delivery to the app stays in arrival
  order per sender page (Yjs-based apps stall on reordering). Data that comes before its key
  waits for the key (64 messages). Data that comes before the app here joined the channel (it
  is still starting) is kept for 15 s (64 messages) and handed over on join; the shim keeps
  data that arrives before the app's `setListener`.
- Compatibility: messages without `batch`/`part` (0.1.2) are delivered as one message.

What the server sees in an encrypted room: who sends realtime data to whom, when, and how
much; not the content.

### Running the app: a second origin and a service worker

An `.xdc` is many files with relative URLs (scripts, images, wasm, sounds). The robust way to
serve that in a browser is a **service worker** that answers every request from the unpacked zip:

```
Element (app.element.io)
 └─ widget iframe  (widget origin: library, Widget API, the update log)
     └─ app iframe (runner origin, never the widget's)
         boot.html  → registers sw.js, receives the files from the widget, caches them
         /app/<key>/index.html, …  ← served by sw.js from Cache Storage, with a CSP header
         /app/<key>/webxdc.js       ← generated by sw.js: the API shim, bound to the widget by postMessage
```

- The runner origin must differ from the widget origin. Otherwise an app with
  `allow-same-origin` could reach into the widget and the user's room.
- The CSP the service worker attaches is `default-src 'self' data: blob:` plus `connect-src 'self'`
  and the inline/eval allowances that existing apps need. Nothing leaves the runner origin, and
  that origin serves nothing but the cached app.
- External links and `mailto:` go to the widget, which shows the full URL and asks before opening.
- Production can use one runner origin per instance (`https://{key}.xdc.example.org/`, wildcard
  DNS and certificate). That gives real storage and DOM isolation between apps. With a single
  runner origin, the shim prefixes `localStorage`, `sessionStorage` and IndexedDB names per
  instance. That isolation is **functional, not a security boundary.**

### Administration and loading

The widget has three views:

1. **Room apps**: every instance in the room with its icon, name, latest `document`/`summary`
   and Start. Admin actions: pin as its own room widget (`im.vector.modular.widgets`, URL
   `#/?instance=<id>`, so an app gets its own tile in the room), rename, remove.
2. **Add app**: the webxdc.org catalog (search, categories), a local `.xdc` file, or a URL to an
   `.xdc`. Each one becomes an instance after a confirmation step that shows name, size, source
   and the Matrix events it will create.
3. **Player**: the app frame, with the instance name, the latest summary, a "source" link and
   back.

A pinned tile is the same bundle in *runner mode*. It asks only for that one instance's state
event and the update and sync events.

## Possibilities

- About 170 existing offline-first apps (polls, games, editors, calendars, checklists, maps,
  whiteboards) work in a Matrix room without a server and without any change to the apps.
- Updates are end-to-end encrypted in E2EE rooms. The app itself never touches the network.
- Federation for free: every homeserver in the room carries the updates.
- An app can be pinned as a room widget and looks like any other Element widget.
- The same `.xdc` runs in Delta Chat, Cheogram and Matrix, so developers write it once.
- Later: a proper MSC (`m.webxdc.*`), native support in Element X / matrix-rust-sdk, a
  "webxdc" msgtype so the app shows up inline in the timeline, bridges to Delta Chat (same
  update log).

## Drawbacks and limits (honest list)

1. **History reach.** Webxdc assumes every device can replay the full update log. A widget can
   read back only about 20–50 recent timeline events (Element serves `read_events` from its live
   timeline; the Marcade Player answers from the last 50). Mitigations: a local IndexedDB copy of
   the log, peer sync from any open member, and batched updates. Still, a latecomer who joins
   when nobody else has the app open sees only recent updates.
2. **No mobile.** Element X (iOS/Android) does not run general widgets. Element Web, Element
   Desktop and the Marcade Player do.
3. **Instance metadata and the `.xdc` are not encrypted.** Room state is cleartext even in E2EE
   rooms, so a key stored there would protect nothing. The app code and icon sit in the media repo
   in clear. Updates (the actual user data) are encrypted.
4. **Rate limits.** Synapse allows about 0.2 events/s per user, shared with their chat. The widget
   announces `sendUpdateInterval = 5000`, batches updates, and backs off on `M_LIMIT_EXCEEDED`.
   Fast games built for Delta Chat's 10 s default feel the same; apps that ignore the interval
   are slowed down.
5. **"No internet" is best effort in a browser.** CSP blocks fetch, XHR, images, scripts, frames
   and form posts to other origins. Browsers cannot fully block WebRTC ICE candidates or DNS
   prefetch from inside a page. Delta Chat controls its webview; a browser tab is not a webview.
6. **Shared runner origin.** Without per-instance subdomains, apps can see each other's storage
   and, when two are open side by side, each other's DOM. Deploy with a wildcard origin for real
   isolation.
7. **Service worker in a nested third-party frame.** This works partitioned in Chromium, Firefox
   and Electron (Element Desktop). Browsers with strict third-party storage blocking may refuse
   it, and the player then says so.
8. **Ordering.** Every device sees updates in its own arrival order, as in Delta Chat. Apps
   written for webxdc already cope with this.
9. **Power levels.** Adding an app writes room state, so it needs PL 50 by default. Members can
   use every app, because updates are ordinary timeline events.
10. **Consent prompt.** The library needs about 20 capabilities, a pinned single-app tile 16.
11. **Apps assume an origin root.** Many apps built for Delta Chat load `/assets/x.js` or climb
    above their root with `../`. The service worker maps both into the app that asked. An app
    that navigates to a root path works only through the same-origin referrer.
12. **Peer sync trusts the peer.** An offer replays other people's updates as the peer claims
    them. Any member can already send any payload, so this adds little, but it means history is
    only as honest as the members who serve it.

## Status (2026-10-26)

Built as planned. Two things changed during implementation:

- The runner's cache is not trusted. Anything framed in the same client can frame `boot.html`
  and fill it, so the widget always sends the files (verified against the room's SHA-256), and
  the runner wipes the cache for that key before writing them.
- The `webrtc` CSP directive is not shipped in browsers (Chromium logs an error for it). The
  runner's service worker therefore puts a guard script first into every page it serves; it
  removes WebRTC from the page and from every same-origin frame the page creates (about:blank,
  srcdoc, the app's own pages), and gives sandboxed frames `allow-same-origin` so they stay
  within reach. Frames from `data:`/`blob:` are not allowed. `test/e2e/webrtc-guard.spec.ts`
  runs the webxdc-test app's 12 probes; 0.1.0 failed 6 of them (it leaked the public IP).

Tested in Chromium and Firefox with a mock Matrix host and two origins (see README): all 167
apps of the webxdc.org catalog start, and their main interaction and two-user sync are driven by
`test/e2e/apps/`. Every app was also recorded with 1–4 people in real Element Web on
chat.blackpony.club (the webxdc show, https://webxdc-show.widgets.marcade.store/), which found
the realtime problems fixed in 0.1.2–0.1.5. Deployed on marcade.store with the runner on its own
origin. **Not yet tested** on the Marcade Player or Safari.

Known limits from that work: apps that expect to be served at an origin root (Code
Playground's own service worker, Next-Tools' router) need one runner origin per instance;
Excalidraw sometimes does not merge two scenes started at the same moment (an app issue; saving
with Ctrl+S works around it); Quake III's multiplayer does not connect.

Next steps: per-instance runner origins (wildcard DNS and certificate), the Marcade Player, an
MSC draft for the event types.

## Build steps

1. Scaffold: Vite + Svelte 5 + TypeScript + `matrix-widget-api` + `fflate` (unzip). The
   `runner/` directory is plain JS with no build, deployed to the runner origin.
2. Runner: `boot.html`, `sw.js` (serving files, CSP headers, the shim with baked-in
   `selfAddr`/`selfName`), and the shim (`webxdc` API, storage namespacing, link interception).
3. Widget core: `xdc.ts` (unzip, manifest, icon), `log.ts` (IndexedDB log, serials), `room.ts`
   (instances, updates, batching, rate limiting, sync), `realtime.ts` (realtime channels over
   to-device), `bridge.ts` (postMessage with the app frame).
4. UI: room apps, add app (catalog, file, URL), player, pin/rename/remove.
5. Tests: vitest for the pure parts. Playwright with the mock host: add a catalog app, start it,
   send an update, see it come back with a serial; a second client sees it; external fetches are
   blocked.
6. README with capabilities and the deployment of both origins.
