# How other hosts run webxdc, compared with this widget

Read on 2026-10-26 from shallow clones of deltachat-core-rust, deltachat-desktop,
deltachat-android, deltachat-ios, Cheogram (XMPP) and webxdc-dev (the official simulator), plus
the spec (webxdc.org, spec 1.4). File references are into those clones at that date. Delta Chat's
UIs only run the page; storage, serials, limits, history and realtime live in the Rust core, so
"Delta Chat" below means core unless a UI is named.

## Where the app runs

| | Delta Chat | Cheogram | webxdc-dev | **This widget** |
|---|---|---|---|---|
| Container | Electron: one `BrowserWindow` per app, scheme `webxdc://<acc>.<msg>.webxdc`, per-account session partition. Android: WebView, origin `acc<id>-msg<id>.localhost`. iOS: WKWebView with a custom scheme handler | Android WebView | iframe in a dev server | iframe on a separate runner origin, files served by a service worker from Cache Storage under `/app/<key>/` |
| Origin per app instance | yes (Electron, Android, iOS) | yes | no | **no**: one runner origin for all instances; storage separated by name prefixes in `shim.js` |
| Files served from | the .xdc, read on demand by core | the .xdc | the .xdc | the .xdc, sent by the widget each start and verified against the room's SHA-256 |
| CSP | `default-src 'self'`, no `data:` (iOS `WebxdcViewController.swift:620`, same text in webxdc-dev `backend/app.ts`) | `default-src 'self'` plus `webrtc 'block'` | as iOS | `default-src 'self' data: blob:`, `frame-src 'self'`; more permissive, so apps that run there run here |
| Network denial beyond CSP | Electron: `--host-resolver-rules` DNS blackhole, blackhole proxy, request filter (`target-electron/src/index.ts:21`). Android: a hidden WebView allocates all 500 `RTCPeerConnection`s of the renderer and the app refuses to start if that fails (`WebRtcHolder.java`). iOS: a content rule list blocks every non-`webxdc://` URL | CSP only | none | `guard.js` removes WebRTC from the page and every frame it makes; `webrtc-guard.spec.ts` runs the webxdc-test app's 12 probes. DNS prefetch cannot be stopped from inside a page |
| `window.webxdc` | injected script; not frozen (Android, iOS, webxdc-dev) | injected | injected | built from `shim.js` plus the instance's values, `Object.freeze`d |

A browser iframe cannot do what Electron or a WebView does at the process level. What we have is
the strongest a page can do, and it is tested; the remaining gap (DNS prefetch, a future browser
API) is inherent to running inside someone else's client.

## Updates

| | Delta Chat core | Cheogram | webxdc-dev | **This widget** |
|---|---|---|---|---|
| `sendUpdateInterval` | 1000 ms (`context.rs:495`, a 3-per-3-s rate limit) | not exposed | 1000 ms, not enforced | 5000 ms |
| `sendUpdateMaxSize` | `RECOMMENDED_FILE_SIZE` ≈ 22 MB (`webxdc.rs:1001`); 100 KiB only splits the outgoing batch | not exposed | 999 999, not enforced | 128 000 B, enforced in `shim.js`; over 36 kB an update goes to an encrypted upload |
| Validation | unknown fields dropped; updates in a contact request or after leaving a group rejected | none | none | `sanitizeUpdate`: only the spec's fields, JSON only |
| `serial` | SQLite rowid per device, `uid` unique for dedup across transports | per-device SQLite | contiguous 1-based | per-device IndexedDB counter, sender ids for dedup |
| Delivery to the app | pull: the page calls `getStatusUpdates(lastSerial)` on each notification (desktop preload, Android/iOS `webxdc.js`) | pull | push | push over a `MessagePort`; `setUpdateListener(cb, serial)` replays from the log |
| Batching / rate limiting | core's rate limiter | none | none | token bucket at Synapse's ~0.2 events/s; consecutive updates of one app share an event (up to 100) |
| `getAllUpdates()` | returns `[]` | missing | returns all | returns the log |
| `info` | one chat message; a sender's consecutive infos replace the last one (`webxdc.rs:296-327`) | the message body | shown in the UI | one `m.notice` per app per 10 s |
| `href` | stored on the info message; tapping it starts the app there | missing | shown | an "Open" button per message in the Player |
| `document` / `summary` | shown on the message | shown | shown | caption under the app's name |
| `notify` | a system notification, from others only; muted chats suppress `"*"` | missing | shown | `m.mentions` on the notice, so the client notifies |

The 128 kB cap and the 5 s interval follow the spec's defaults; Delta Chat is far more generous,
and the simulator app developers test against enforces nothing. Apps written only against those
may send bigger or more frequent updates than the spec allows; the catalog test found none that
broke on it, but it is the most likely incompatibility.

## History for latecomers

Delta Chat has no sync protocol: every device keeps the log in SQLite, and every send or forward of
an app message attaches the whole log inside the message (`mimefactory.rs`), so a newcomer gets it
with the app. Cheogram gets history from the server's message archive (MAM). We cannot attach the
log to the instance (room state is unencrypted) and a widget reads back only part of the timeline,
so we have the peer sync: a newcomer asks, one open peer answers with the log (inline or as an
encrypted upload). The gap: when nobody else has the app open, the newcomer waits. Relations
(`m.relates_to` to an anchor message, MSC3869) would let the server page the whole encrypted
history and would close that gap; the Marcade Player does not implement relations.

## Realtime

| | Delta Chat core | Cheogram | **This widget** |
|---|---|---|---|
| Transport | iroh gossip; the topic is a random 32 bytes in an encrypted header of the app's mail, node addresses advertised by hidden mails (`peer_channels.rs`) | an XMPP `<message>` with `<no-store>` and base64 data | Matrix to-device events to all devices of every joined member (≤ 50) |
| Size limit | 128 KiB per gossip message | none stated | 128 kB per message, sent in parts of 40 kB |
| Encryption | iroh's transport encryption, no app-level encryption | as the chat | the widget encrypts the payload (AES-GCM, key announced in the encrypted timeline), because clients cannot encrypt a to-device message for `"*"` |
| Ordering | none | none | in arrival order per sender page |
| Data before `setListener` | dropped (desktop) | dropped | kept (shim and widget) |
| Own data | not echoed | not echoed | not echoed |

Ours is the only one with ordering and the only one that had to add its own encryption; both came
out of recording apps with two Element clients (0.1.2–0.1.5).

## Identity, links, sendToChat

- `selfAddr`: core hashes `"<fingerprint>-<message id>"` with SHA-256 (`webxdc.rs:1007`); ours
  hashes `"webxdc:<instance>:<user>"`, the same construction. Cheogram uses the real JID or
  occupant id, so apps there can be linked across apps.
- Links: the spec (1.3) requires the full URL and a privacy warning before an internet link opens.
  Electron shows a native dialog with an allow-list of schemes and lets `mailto:` through;
  Android prompts only for `target=_blank` links; Cheogram opens http and mailto links without
  asking. Ours asks for every external URL, `mailto:` included, with the warning.
- `sendToChat`: Delta Chat opens a chat picker and sets up a draft (the user edits and sends);
  an `.xdc` sent this way becomes a playable app on send. Ours asks, then sends into the current
  room; an `.xdc` becomes an app in the room (0.1.1).
- `importFiles`: Delta Chat offers recent attachments; ours is the browser's file picker.

## Storage, permissions, lifecycle

- Delta Chat clears an app's web storage when its message is deleted (Android: a worker every
  ~15 min; Electron: a sweep over config keys). **Ours never clears**: the runner's
  `xdc-<key>` caches and the prefixed localStorage/IndexedDB stay until the browser evicts them.
- Delta Chat Android asks per app for camera, microphone, location and motion sensors and
  remembers the answer. Ours allows sensors and fullscreen on the frame, never camera, microphone
  or location.
- `min_api` in `manifest.toml`: core replaces `index.html` with a "needs a newer messenger" page
  when the app asks for more than it offers (`webxdc.rs:903`). Ours ignores the field.
- Icons: core requires PNG/JPEG up to 4096 px; ours takes the file as it is.
- iOS reloads the app page every time its view appears; Electron apps are top-level documents
  (`window.top === window`), while ours run in a nested frame, which an app can tell.

## Tests

Delta Chat's UIs have no webxdc tests (desktop's e2e only adds and forwards an app); core has
unit tests for serials, limits and validation; webxdc-dev tests the simulator's semantics. Ours:
31 unit tests, 12 widget e2e in two browsers, a start test of all 167 catalog apps in both
deployment layouts, the WebRTC guard, and the per-app interaction specs, plus every app recorded
with 1–4 people in real Element.

## What to take from this

1. **Storage cleanup** when an app is removed from the room (caches, prefixed storage): Delta
   Chat does it, we do not.
2. **`min_api`**: honour it, it is a few lines in `xdc.ts` and the Player.
3. **Limits**: keep the spec's defaults, but watch for apps built against Delta Chat's 1 s /
   22 MB; raising `sendUpdateMaxSize` is possible because large updates already go to an
   encrypted upload.
4. **History**: relations would remove the "nobody online" gap; it needs host support.
5. **Per-instance origins** are the one isolation step every native host takes and we lack; they
   need wildcard DNS and a certificate for the runner.
