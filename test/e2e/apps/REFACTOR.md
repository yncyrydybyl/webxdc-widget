# Refactor brief: one slice spec onto the shared library

Repo: the webxdc-widget checkout. The six files `test/e2e/apps/slice-N.spec.ts`
were written by six agents, each with its own copies of the same helpers (watching errors, finding the
app frame, adding the .xdc, starting Bob, relaying realtime, held presses, "did the canvas react",
writing the result JSON). `test/e2e/apps/lib.ts` now holds one version of each. Your job: make your
slice use `lib.ts` and delete its local copies. **Behaviour must stay the same: the same tests pass
before and after.**

## Rules

- Edit only your `slice-N.spec.ts`. Do **not** edit `lib.ts`, `../real.ts`, other slices, or anything
  under `src/` or `runner/`. If `lib.ts` lacks something your slice needs, keep a *thin* local wrapper
  built on `lib.ts` (a few lines) and say so in your final message.
- Keep every test and its assertions. Keep each test's `test.skip` conditions and the per-slice `deep`/
  `Ctx` shape if the slice has one (you may slim it down with `newResult`, `saveResult`, `firstLine`,
  `watch`, `addXdc`, `startPeer`), but do not change what a test checks.
- Prefer the library's names (`addXdc`, `startPeer`, `press`, `pressFrame`, `hold`, `drag`, `reacts`,
  `relayRealtime`, `updates`, `chats`, `toDevice`, `watch`, `covered`, `uncover`, `appFrame`,
  `appFrameAny`, `stage`, `until`, `dump`, `shot`, `ALICE`, `BOB`, `XDC`, `DEEP`). A local alias is fine
  where it keeps a diff small (`const start = addXdc;`), but not a second implementation.
- Differences to watch: `press` in lib takes a `Locator` (`a.locator("canvas")`), `pressFrame` the whole
  app frame; `reacts(page, loc, act)` returns `{ idle, changed }`; `startPeer` returns `{ page, frame,
  app }`; `relayRealtime` delivers each to-device message once; `watch` returns `{ errors, blocked }`.
  Adapt call sites rather than re-adding the old signature.
- The test servers are shared and already running (mock host http://localhost:4185, runner
  http://127.0.0.1:4186); never start, stop or rebuild them, never run `pnpm build`.

## Procedure

1. Baseline: `ALL_APPS=1 pnpm exec playwright test test/e2e/apps/slice-N.spec.ts --project=chromium
   --workers=3 --reporter=line 2>&1 | tail -40` — note which tests pass, fail or skip (some fail or skip
   on purpose; that is the baseline).
2. Refactor.
3. `pnpm check` must pass (it type-checks the specs with noUnusedLocals).
4. Run the slice again: the pass/fail/skip set must be identical to the baseline. A test that fails
   in both is fine; a test that passed before and fails now is a regression you must fix. Flaky
   timing: rerun the single test (`-g <id>`) before concluding.
5. Final message (≤ 15 lines): lines before/after, what you replaced, any thin wrappers you kept
   and why, the baseline and final pass/fail/skip counts, anything in lib.ts you would change.
