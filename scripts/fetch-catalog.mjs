/*
 * Downloads the webxdc.org catalog and every app in it to test/real/all/, for
 * all-apps.spec.ts. Files already there are kept.
 *   node scripts/fetch-catalog.mjs [catalog-url]
 */
import { mkdir, stat, writeFile } from "node:fs/promises";

const catalog = process.argv[2] ?? "https://apps.testrun.org/xdcget-lock.json";
const dir = new URL("../test/real/all/xdc/", import.meta.url);
await mkdir(dir, { recursive: true });

const apps = await (await fetch(catalog)).json();
await writeFile(new URL("../catalog.json", dir), JSON.stringify(apps, null, 1));
let fetched = 0;
for (const app of apps) {
    const file = new URL(`${app.app_id}.xdc`, dir);
    if (await stat(file).catch(() => null)) continue;
    const res = await fetch(new URL(app.cache_relname, catalog));
    if (!res.ok) {
        console.error(`${app.app_id}: ${res.status}`);
        continue;
    }
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    fetched++;
}
console.log(`${apps.length} apps in the catalog, ${fetched} downloaded to test/real/all/xdc/`);
