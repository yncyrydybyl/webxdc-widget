# webxdc apps for Matrix

A Matrix widget that plays [webxdc](https://webxdc.org) apps in a room. You add an app from the
webxdc.org catalog, from an `.xdc` file or from a link, and everyone in the room can start it.
Each app runs in an isolated frame without internet access. Its updates travel through the
room, end-to-end encrypted in encrypted rooms. No server is needed beyond static hosting.

```
"Add app" → pick Checklist from the catalog → "Add to room"
→ everyone in the room: Start → the same shared checklist
```

The design, the possibilities and the drawbacks are in [PLAN.md](PLAN.md).

## Try it

```sh
pnpm install
pnpm dev     # widget on http://localhost:5173, runner on http://127.0.0.1:5174 (a second origin)
```

In Element:

```
/addwidget http://localhost:5173/#/?matrix_user_id=$matrix_user_id&matrix_display_name=$matrix_display_name&theme=$org.matrix.msc2873.client_theme
```

**Identity.** The Widget API cannot tell a widget who is using it; only the URL can
(`$matrix_user_id`, filled in by the client). From a bare URL (the store's `/addwidget` line,
the Marcade Store widget, the Player), the widget adds those template variables to its own
widget event once. It may do so because whoever added it may change widgets. The client then
reloads it. Until it knows the user, apps do not start: every user would get the same
`selfAddr`.

Opened outside a client, the widget runs standalone. You can try apps there; their updates stay
on the page.

## What it does

| | |
|---|---|
| **Room apps** | Every app in the room with its icon and its latest `summary`/`document` ("0 / 2 done"). **Start**, plus **Pin** (adds the app as its own room widget), **Rename** and **Remove** for people allowed to change room settings. |
| **Add app** | The webxdc.org catalog (search, categories), an `.xdc` file, or an https link. Before anything is sent, a confirmation shows the name, size, source and hash. **Try it first** runs the app on this device only. |
| **Player** | The app frame, with **Sync** (asks open peers for history) and **Source**. External links and `sendToChat()` ask first. |

## How webxdc maps onto Matrix

| webxdc | Matrix |
|---|---|
| the shared app | `.xdc` in the media repo + state event `de.datanauten.webxdc.instance` (state key = instance id) |
| `sendUpdate()` | timeline event `de.datanauten.webxdc.update` `{instance, updates:[…]}`; consecutive updates share an event; updates above 36 KB go to an encrypted upload |
| `setUpdateListener(cb, serial)` | replay from this device's IndexedDB log, then live events; serials are stable across reloads |
| `selfAddr` / `selfName` | `sha256("webxdc:<instance>:<user id>")` (32 hex) / the display name |
| `isAppSender` | you sent the instance state event |
| `info` / `notify` | an `m.notice` ("Checklist: Alice added an item"), with `m.mentions` for `notify` |
| `sendToChat()` | after confirmation: `m.file`/`m.image` (encrypted in E2EE rooms) and `m.text` |
| `importFiles()` | the browser's file picker |
| `joinRealtimeChannel()` | to-device `de.datanauten.webxdc.realtime` to all devices of joined members (at most 50), the payload encrypted by the widget in encrypted rooms (see "Realtime" in PLAN.md) |
| history for latecomers | `de.datanauten.webxdc.sync` request → one open peer answers with the log |

Announced limits: `sendUpdateInterval = 5000`, `sendUpdateMaxSize = 128000`. A token bucket
keeps the widget within Synapse's rate limit and retries on `M_LIMIT_EXCEEDED`.

## Capabilities

The library asks for:

| Capability | Why |
|---|---|
| `io.element.requires_client` | no session of its own |
| `send`/`receive.state_event:de.datanauten.webxdc.instance` | list and add apps |
| `send`/`receive.state_event:im.vector.modular.widgets` | pin an app as its own widget |
| `send`/`receive.event:de.datanauten.webxdc.update`, `…sync` | updates and history |
| `org.matrix.msc4039.upload_file`, `download_file` | the `.xdc`, icons, large updates |
| `send.event:m.room.message#m.notice` | `info` and `notify` |
| `send.event:m.room.message#m.text`, `#m.file`, `#m.image` | `sendToChat()`, after you confirm |
| `receive.state_event:m.room.encryption` | encrypt `sendToChat()` files in E2EE rooms |
| `receive.state_event:m.room.member` | display names, `notify` targets, realtime recipients |
| `org.matrix.msc3819.send`/`receive.to_device:de.datanauten.webxdc.realtime` | `joinRealtimeChannel()` |

A pinned tile (`#/?instance=<id>`) asks to read only its own instance
(`receive.state_event:de.datanauten.webxdc.instance#<id>`) and cannot add, pin or remove apps.

## Deploying: two origins

```
https://webxdc.example.org/          the widget (dist/)
https://xdc-run.example.org/         the runner (runner/, static, no build)
  or https://{key}.xdc.example.org/  one origin per app instance (wildcard DNS + certificate)
```

Build with the runner URL, which also becomes the widget's `frame-src`:

```sh
VITE_RUNNER_URL=https://xdc-run.example.org/ pnpm build
# or: VITE_RUNNER_URL=https://{key}.xdc.example.org/ pnpm build
```

The runner **must not** share the widget's origin: an app with `allow-same-origin` could then
reach into the widget. Both the widget and the runner refuse that setup. Use one origin per
instance where you can. On a shared runner origin, apps are kept apart by name only:
`localStorage`, IndexedDB and Cache Storage are prefixed per instance, but a hostile app can get
around that.

**On marcade.store** the build copies `runner/` into `dist/runner/`, and the catalog entry
serves the same bundle from two subdomains (`own_origin: webxdc`, alias `webxdc-run`):

```
https://webxdc.widgets.marcade.store/0.1.0/              the widget
https://webxdc-run.widgets.marcade.store/0.1.0/runner/   the runner
VITE_RUNNER_URL=https://webxdc-run.widgets.marcade.store/0.1.0/runner/ pnpm build
```

`MARCADE_LAYOUT=1 pnpm exec playwright test widget` checks that layout locally (a server
imitating the store's nginx: versioned subpath, SPA fallback; build with
`VITE_RUNNER_URL=http://127.0.0.1:4192/0.1.0/runner/`). One runner origin is shared by all
apps there, so storage isolation between apps is by name only.

nginx for the runner (what `scripts/runner-server.mjs` sends in development):

```nginx
location / {
    root /srv/webxdc-runner;
    add_header Content-Security-Policy "default-src 'self'; frame-ancestors *; object-src 'none'; base-uri 'none'" always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Content-Type-Options nosniff always;
    add_header Cache-Control no-cache always;
}
```

App pages get their CSP from `runner/sw.js` (`default-src 'self' data: blob:`, inline code and
eval allowed, nothing from elsewhere). For the widget, send `frame-ancestors *`. Element Desktop
frames widgets from `vector://vector`. Do not send `X-Frame-Options`.

### How an app runs

```
widget ──frame──▶ runner/boot.html     registers sw.js; gets the files (always from the widget,
                                      verified against the room's SHA-256), caches them,
                                      navigates to app/<key>/index.html
          sw.js  serves app/<key>/…   from Cache Storage, with the CSP; maps root paths
                                      ("/assets/x.js", common in apps built for Delta Chat)
                                      into the app; builds webxdc.js from shim.js plus the
                                      instance values (selfAddr, …)
          shim.js (window.webxdc)     talks to the widget over a MessagePort
```

## Tests

```sh
pnpm test                    # vitest: room logic, sync, batching, crypto, .xdc parsing, catalog
pnpm test:e2e                # Playwright, Chromium + Firefox, mock Matrix host, two origins
NETWORK=1 pnpm exec playwright test catalog   # real apps from webxdc.org; two users share a Checklist
```

The e2e suite runs the widget on `localhost` and the runner on `127.0.0.1`. That makes the
runner a third-party frame with a partitioned service worker, as under Element. Checked there:
files and relative or absolute paths load from the `.xdc`; `fetch`, images and frame navigation
to other sites are blocked; links ask first; the log survives reloads; adding from a file; a
pinned tile's narrow capabilities. Checked with real apps: Checklist, Poll, Chess, Editor,
Excalidraw and Tower Builder start, and a Checklist syncs between two users.

**All 167 catalog apps** (2026-10-26): `node scripts/fetch-catalog.mjs`, then
`ALL_APPS=1 pnpm exec playwright test all-apps webrtc-guard` starts every app once;
`test/e2e/apps/slice-*.spec.ts` drive each app's main interaction and the sync to a second user.

**Real Element:** every catalog app was recorded with 1–4 people in Element Web on
chat.blackpony.club, realtime apps included (the webxdc show,
https://webxdc-show.widgets.marcade.store/, engine in the `webxdc-show` repo).

**Not yet tested:** the Marcade Player, WebKit/Safari.

## Limits

How Delta Chat, Cheogram and the webxdc simulator do the same things, and where we differ:
[docs/COMPARISON.md](docs/COMPARISON.md).

See "Drawbacks" in [PLAN.md](PLAN.md). In short: a widget can read back only recent timeline
events, so history relies on the local log and on peers that are online; Element X does not run
widgets; the app list and files are not encrypted; "no internet" is enforced by CSP plus a WebRTC guard in every app page (CSP cannot block
WebRTC); DNS prefetch is not covered.

## Source

Public mirror: https://github.com/yncyrydybyl/webxdc-widget. Development, CI and the store
release run on code.fe80.eu (`dtn10/webxdc-widget`, see CICD.md); the mirror follows `main`.

## License

AGPL-3.0-or-later
