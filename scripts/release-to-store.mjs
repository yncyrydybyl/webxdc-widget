#!/usr/bin/env node
/*
 * Release a tagged version to marcade.store: opens a merge request in
 * dtn10/marcade-store that appends the version to catalog/de.datanauten.webxdc
 * (pinned to the tag's commit) and adds its changelog. Runs in CI on tags
 * v<major>.<minor>.<patch>; the store's MR pipeline then builds the bundle.
 * Merging and the manual deploy:live job stay with a person, as for every
 * store entry.
 *
 * Needs STORE_TOKEN: a project access token of dtn10/marcade-store (role
 * Developer, scope api). Locally: STORE_TOKEN=… CI_COMMIT_TAG=v0.2.0 node scripts/release-to-store.mjs
 * DRY_RUN=1 prints what it would do.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ID = "de.datanauten.webxdc";
const RUNNER = (v) => `https://webxdc-run.widgets.marcade.store/${v}/runner/`;
const API = process.env.CI_API_V4_URL ?? "https://code.fe80.eu/api/v4";
const STORE = process.env.STORE_PROJECT_ID ?? "453";
const TOKEN = process.env.STORE_TOKEN;
const DRY = !!process.env.DRY_RUN;

const fail = (msg) => {
    console.error(`release-to-store: ${msg}`);
    process.exit(1);
};

const tag = process.env.CI_COMMIT_TAG ?? execSync("git describe --tags --exact-match").toString().trim();
const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
if (!m) fail(`tag ${tag} is not v<major>.<minor>.<patch>`);
const version = m[1];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.version !== version) fail(`tag ${tag} but package.json says ${pkg.version}`);
const sha = process.env.CI_COMMIT_SHA ?? execSync("git rev-parse HEAD").toString().trim();
let changelog;
try {
    changelog = readFileSync(`changelogs/${version}.txt`, "utf8").trim();
} catch {
    fail(`changelogs/${version}.txt is missing`);
}
if (changelog.length > 500) fail(`changelogs/${version}.txt has ${changelog.length} characters; the store allows 500`);
if (!TOKEN && !DRY) fail("STORE_TOKEN is not set (project access token of dtn10/marcade-store, Developer, scope api)");

async function api(method, path, body, { allow404 = false } = {}) {
    const res = await fetch(`${API}${path}`, {
        method,
        headers: { "PRIVATE-TOKEN": TOKEN ?? "", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (allow404 && res.status === 404) return null;
    if (!res.ok) fail(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return text;
}

const metaPath = `catalog/${ID}/metadata.yml`;
// META_FILE: a local copy instead of main (tests, dry runs).
const meta = process.env.META_FILE
    ? readFileSync(process.env.META_FILE, "utf8")
    : await api("GET", `/projects/${STORE}/repository/files/${encodeURIComponent(metaPath)}/raw?ref=main`, null, { allow404: true });
if (meta === null) {
    // The first release goes in with the catalog entry itself (a hand-made MR).
    console.log(`${metaPath} is not on main yet: merge the first catalog MR, then tag again or rerun this job`);
    process.exit(0);
}
if (meta.includes(`version: "${version}"`)) {
    console.log(`${version} is already in the catalog on main; nothing to do`);
    process.exit(0);
}
// hosting.builds is the last block of the entry; a new version goes at its end.
if (!/output: dist\s*$/.test(meta)) fail(`${metaPath} does not end with a builds entry; add ${version} by hand`);
const entry = [
    `    - version: "${version}"`,
    `      commit: ${sha} # tag ${tag}`,
    `      subdir: .`,
    `      build: corepack enable pnpm && pnpm install --frozen-lockfile && VITE_RUNNER_URL=${RUNNER(version)} pnpm build`,
    `      output: dist`,
].join("\n");
const content = `${meta.trimEnd()}\n${entry}\n`;
const branch = `release/webxdc-${version}`;
const title = `catalog: webxdc apps ${version}`;

if (DRY) {
    console.log(`would open "${title}" from ${branch} with:\n${entry}\nchangelog: ${changelog}`);
    process.exit(0);
}

await api("POST", `/projects/${STORE}/repository/commits`, {
    branch,
    start_branch: "main",
    commit_message: `${title} (${ID})\n\nFrom ${process.env.CI_PROJECT_URL ?? "webxdc-widget"} ${tag} (${sha}).`,
    actions: [
        { action: "update", file_path: metaPath, content },
        { action: "create", file_path: `catalog/${ID}/changelogs/${version}.txt`, content: `${changelog}\n` },
    ],
});
const mr = JSON.parse(
    await api("POST", `/projects/${STORE}/merge_requests`, {
        source_branch: branch,
        target_branch: "main",
        title,
        remove_source_branch: true,
        description: [
            `Release ${tag} of webxdc apps, opened by the widget's CI (${process.env.CI_PIPELINE_URL ?? "local run"}).`,
            "",
            `- commit \`${sha}\`, tests green in the widget pipeline`,
            `- served at https://webxdc.widgets.marcade.store/${version}/, runner at ${RUNNER(version)}`,
            "",
            "After merge: run `deploy:live` on main. No new routes, so no helm upgrade is needed.",
        ].join("\n"),
    }),
);
console.log(`opened ${mr.web_url}`);
