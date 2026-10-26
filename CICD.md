# CI/CD

The widget is built, tested and released from this repo (code.fe80.eu `dtn10/webxdc-widget`)
and served by marcade.store. The webxdc apps are not ours. The widget loads the live
webxdc.org catalog (`apps.testrun.org/xdcget-lock.json`), and an `.xdc` added to a room goes
to that room's media repo. Marcade hosts only the widget and its runner.

```
push / MR ──▶ check ─▶ e2e (2 layouts, Chromium; Firefox as a warning) ─▶ build
tag vX.Y.Z ─▶ same ─▶ release:store ──MR──▶ dtn10/marcade-store
                                           ├ MR pipeline: validate:catalog, build:dist (from the pinned commit)
                                           ├ merge                         (a person)
                                           └ deploy:live (manual)          (a person)
                                               ├ https://webxdc.widgets.marcade.store/X.Y.Z/          widget
                                               └ https://webxdc-run.widgets.marcade.store/X.Y.Z/runner/  runner
schedules ─▶ verify:live    the e2e suite against the deployed widget (daily)
          └▶ verify:catalog real webxdc.org apps start and sync (weekly)
```

## Pipeline (`.gitlab-ci.yml`)

| Job | When | What |
|---|---|---|
| `check` | every push, MR | `svelte-check`, vitest |
| `e2e` | every push, MR | Playwright with the mock Matrix host, Chromium and Firefox. Run twice: the plain layout (runner on its own port), and the store's layout (`MARCADE_LAYOUT=1`: bundle under `/<version>/`, nginx-style SPA fallback, runner at `/<version>/runner/` of another host). Runs on the `astra` runner (memory). Chromium (`e2e`) is the gate. Firefox (`e2e:firefox`) may fail: in the runner's pod (64 MB `/dev/shm`) its content processes crashed at start in the first pipeline, so it runs with one content process and Fission off, as a warning. |
| `build` | every push, MR | the production bundle with `VITE_RUNNER_URL=https://webxdc-run.widgets.marcade.store/<version>/runner/`, as the store builds it |
| `release:store` | tag `vX.Y.Z`, `STORE_TOKEN` set | `scripts/release-to-store.mjs`: checks tag = `package.json` version and `changelogs/X.Y.Z.txt` (≤ 500 chars), then commits to a branch of the store via the API (new `builds` entry pinned to the tag's commit, plus the changelog) and opens the MR |
| `verify:live` | schedule `CHECK=live`, manual on main | `WIDGET_URL=https://webxdc.widgets.marcade.store/latest/index.html` e2e: the deployed widget and runner, end to end (mock host local) |
| `verify:catalog` | schedule `CHECK=catalog`, manual on main | `NETWORK=1` catalog tests: six real apps from webxdc.org start, and a Checklist syncs between two users. Catches upstream changes (catalog format, CORS, apps) |

## Releasing a version

1. Bump `version` in `package.json`, write `changelogs/X.Y.Z.txt`, commit.
2. `git tag vX.Y.Z && git push origin main --tags`.
3. The tag pipeline opens the store MR. When its pipeline is green, merge it and run
   `deploy:live` on the store's main. No helm step: the routes exist already.
4. `verify:live` (manual, or the next daily run) checks the new `latest`.
5. Pinned room tiles and `/addwidget` lines use versioned URLs and keep the old version. The
   Marcade Store widget offers the update in rooms after its own release.

The first version (0.1.0) went in with the catalog entry itself, by hand. It also added the
two routes, which needed `helm upgrade --install widgets …` before `deploy:live`.

## One-time setup

| What | Who | How |
|---|---|---|
| Project, push, allowlist store 453 | done / user | see the deploy notes |
| `STORE_TOKEN` | user | project access token on `dtn10/marcade-store`: role Developer, scope `api`. Store it masked and protected as a CI/CD variable of this project. |
| Protected tags `v*` | user | so tag pipelines receive the protected `STORE_TOKEN` |
| Schedules | agent or user | `verify:live` daily (`CHECK=live`), `verify:catalog` weekly (`CHECK=catalog`) |

## Why these choices

- **The store builds from source again.** The store's `build:dist` rebuilds from the pinned
  commit. The widget pipeline's artifact is a check, not the deployed bytes. That is how every
  store entry works, and it keeps the store reproducible.
- **Deploy stays manual.** `deploy:live` bakes every store app into one image, so it remains
  the store owner's button. The widget pipeline only gets as far as a green MR.
- **The runner URL is per version.** The widget of X.Y.Z frames the runner of X.Y.Z, so a
  release never pairs a widget with another version's shim or service worker.
