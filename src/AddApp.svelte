<script lang="ts">
    /*
     * Getting an .xdc: from a catalog (webxdc.org's by default), a file, or a link.
     * Every way ends in the same confirmation, which says what adding it does.
     */
    import { onDestroy, onMount } from "svelte";
    import AppIcon from "./AppIcon.svelte";
    import { downloadXdc, loadCatalog, matches, shortDescription, type CatalogApp } from "./catalog";
    import type { Controller } from "./controller.svelte";
    import type { InstanceContent } from "./events";
    import { nameFromFile, parseXdc, type Xdc } from "./xdc";

    let { c }: { c: Controller } = $props();

    type Tab = "catalog" | "file" | "link";
    let tab = $state<Tab>("catalog");

    let catalog = $state<CatalogApp[] | null>(null);
    let catalogError = $state("");
    let query = $state("");
    let category = $state("");
    let link = $state("");
    let busy = $state("");
    let error = $state("");

    interface Candidate {
        xdc: Xdc;
        bytes: Uint8Array<ArrayBuffer>;
        description?: string;
        origin?: InstanceContent["origin"];
        iconUrl: string | null;
    }
    // Raw: the bytes and the origin object go to postMessage, which cannot clone state proxies.
    let candidate = $state.raw<Candidate | null>(null);
    let name = $state("");

    const categories = $derived(catalog ? [...new Set(catalog.map((a) => a.category))].sort() : []);
    const visible = $derived(catalog ? catalog.filter((a) => matches(a, query.trim(), category)) : []);

    onMount(() => {
        loadCatalog(c.catalogUrl)
            .then((apps) => (catalog = apps))
            .catch((err) => (catalogError = err instanceof Error ? err.message : String(err)));
    });

    function forget(): void {
        if (candidate?.iconUrl) URL.revokeObjectURL(candidate.iconUrl);
        candidate = null;
    }
    onDestroy(forget);

    async function take(bytes: Uint8Array<ArrayBuffer>, fallbackName: string, extra: Pick<Candidate, "description" | "origin"> = {}): Promise<void> {
        const xdc = await parseXdc(bytes, fallbackName);
        forget();
        candidate = {
            xdc,
            bytes,
            ...extra,
            iconUrl: xdc.icon ? URL.createObjectURL(new Blob([xdc.icon.bytes], { type: xdc.icon.type })) : null,
        };
        name = xdc.name;
    }

    async function run(label: string, fn: () => Promise<void>): Promise<void> {
        busy = label;
        error = "";
        try {
            await fn();
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        } finally {
            busy = "";
        }
    }

    function pickCatalog(app: CatalogApp): void {
        void run(`Downloading ${app.name}…`, async () => {
            await take(await downloadXdc(app.xdcUrl), app.name, {
                description: shortDescription(app.description),
                origin: { catalog: c.catalogUrl, app_id: app.app_id, tag_name: app.tag_name || undefined },
            });
        });
    }

    function pickFile(e: Event): void {
        const file = (e.currentTarget as HTMLInputElement).files?.[0];
        if (!file) return;
        void run("Reading the file…", async () => take(new Uint8Array(await file.arrayBuffer()), nameFromFile(file.name)));
    }

    function pickLink(e: SubmitEvent): void {
        e.preventDefault();
        const url = link.trim();
        void run("Downloading…", async () => {
            const parsed = new URL(url);
            if (parsed.protocol !== "https:") throw new Error("Use an https:// link to an .xdc file");
            await take(await downloadXdc(parsed.href), nameFromFile(parsed.pathname.split("/").pop() ?? ""));
        });
    }

    function addToRoom(): void {
        const cand = candidate;
        if (!cand) return;
        void run("Adding to the room…", async () => {
            const id = await c.room.addInstance(cand.xdc, cand.bytes, { name: name.trim() || cand.xdc.name, description: cand.description, origin: cand.origin });
            forget();
            c.open({ name: "player", instance: id });
        });
    }

    function tryHere(): void {
        const cand = candidate;
        if (!cand) return;
        void run("Starting…", async () => {
            const inst = await c.room.addLocal(cand.xdc, cand.bytes);
            c.open({ name: "player", instance: inst.id });
        });
    }

    const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
</script>

<header class="top">
    <button class="ghost" onclick={() => c.open({ name: "library" })} aria-label="Back to the room's apps">←</button>
    <h1>{c.status === "standalone" ? "Try an app" : "Add an app"}</h1>
</header>

{#if candidate}
    <section class="candidate" aria-label="App to add">
        <div class="row">
            <AppIcon src={candidate.iconUrl} name={candidate.xdc.name} />
            <label class="grow">
                <span class="small muted">Name</span>
                <input type="text" bind:value={name} maxlength="100" />
            </label>
        </div>
        {#if candidate.description}<p>{candidate.description}</p>{/if}
        <dl class="small">
            <dt>Size</dt>
            <dd>{kb(candidate.xdc.size)}, {candidate.xdc.files.length} files</dd>
            {#if candidate.xdc.sourceCodeUrl}
                <dt>Source</dt>
                <dd><a href={candidate.xdc.sourceCodeUrl} target="_blank" rel="noopener noreferrer">{candidate.xdc.sourceCodeUrl}</a></dd>
            {/if}
            <dt>SHA-256</dt>
            <dd><code>{candidate.xdc.sha256.slice(0, 16)}…</code></dd>
        </dl>
        {#if c.status === "ready"}
            <p class="small muted">
                Adding uploads the file to your homeserver and lists the app in the room, so everyone here can start it. The file and
                name are not encrypted; what people do in the app is (in an encrypted room).
            </p>
        {/if}
        <div class="row">
            {#if c.canAdd}
                <button class="primary" onclick={addToRoom} disabled={!!busy}>Add to room</button>
            {/if}
            <button onclick={tryHere} disabled={!!busy}>{c.canAdd ? "Try it first" : "Try it here"}</button>
            <button class="ghost" onclick={forget} disabled={!!busy}>Cancel</button>
        </div>
        {#if c.canAdd}
            <p class="small muted">"Try it first" runs the app only on this device; nothing is sent to the room.</p>
        {/if}
    </section>
{/if}

{#if busy}<p class="muted" role="status">{busy}</p>{/if}
{#if error}<p class="warn" role="alert">{error}</p>{/if}

{#if !candidate}
    <div class="tabs" role="tablist">
        {#each [["catalog", "Catalog"], ["file", "File"], ["link", "Link"]] as [id, label] (id)}
            <button role="tab" aria-selected={tab === id} onclick={() => (tab = id as Tab)}>{label}</button>
        {/each}
    </div>

    {#if tab === "catalog"}
        <div class="row">
            <input type="search" class="grow" placeholder="Search apps" bind:value={query} aria-label="Search apps" />
            <select bind:value={category} aria-label="Category">
                <option value="">All categories</option>
                {#each categories as cat (cat)}<option value={cat}>{cat}</option>{/each}
            </select>
        </div>
        {#if catalogError}
            <p class="warn">Could not load the catalog: {catalogError}</p>
        {:else if !catalog}
            <p class="muted">Loading the catalog…</p>
        {:else}
            <p class="small muted">
                {visible.length} apps from <a href="https://webxdc.org/apps/" target="_blank" rel="noopener noreferrer">webxdc.org/apps</a>.
                Apps there are community-made and not reviewed.
            </p>
            <div class="catalog">
                {#each visible as app (app.app_id)}
                    <button class="catalog-item" onclick={() => pickCatalog(app)} disabled={!!busy}>
                        <AppIcon src={app.iconUrl} name={app.name} small />
                        <span class="text">
                            <span><strong>{app.name}</strong> <span class="badge">{app.category}</span></span>
                            <span class="small muted ellipsis">{shortDescription(app.description)}</span>
                        </span>
                        <span class="small muted">{kb(app.size)}</span>
                    </button>
                {/each}
            </div>
        {/if}
    {:else if tab === "file"}
        <label class="note">
            <span>Pick a <code>.xdc</code> file, for example one downloaded from <a href="https://webxdc.org/apps/" target="_blank" rel="noopener noreferrer">webxdc.org/apps</a> or sent in Delta Chat.</span>
            <input type="file" accept=".xdc,application/zip,application/x-webxdc" onchange={pickFile} disabled={!!busy} />
        </label>
    {:else}
        <form class="row" onsubmit={pickLink}>
            <input type="url" class="grow" placeholder="https://…/app.xdc" bind:value={link} aria-label="Link to an .xdc file" required />
            <button class="primary" type="submit" disabled={!!busy}>Load</button>
        </form>
        <p class="small muted">The server must allow downloads from web pages (CORS). Most release pages do not; then download the file and use "File".</p>
    {/if}
{/if}
