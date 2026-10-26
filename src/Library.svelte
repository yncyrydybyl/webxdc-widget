<script lang="ts">
    /* The room's apps: start one, or (with the rights) pin, rename and remove. */
    import AppIcon from "./AppIcon.svelte";
    import type { Controller } from "./controller.svelte";
    import type { Instance } from "./room";

    let { c }: { c: Controller } = $props();

    let icons = $state<Record<string, string | null>>({});
    let renaming = $state<string | null>(null);
    let newName = $state("");
    let confirmRemove = $state<string | null>(null);

    $effect(() => {
        for (const inst of c.instances) {
            if (inst.id in icons) continue;
            icons[inst.id] = null;
            void c.room.iconUrl(inst).then((url) => (icons[inst.id] = url));
        }
    });

    function startRename(inst: Instance): void {
        renaming = inst.id;
        newName = inst.content.name;
    }

    async function saveRename(id: string): Promise<void> {
        if (await c.attempt("Could not rename the app", () => c.room.rename(id, newName))) renaming = null;
    }

    async function togglePin(inst: Instance): Promise<void> {
        if (c.isPinned(inst.id)) await c.attempt("Could not remove the tile", () => c.room.unpin(inst.id));
        else await c.attempt("Could not add the app as a room widget", () => c.room.pin(inst.id, c.tileUrl(inst.id)));
    }

    async function remove(id: string): Promise<void> {
        confirmRemove = null;
        await c.attempt("Could not remove the app", () => c.room.remove(id));
    }
</script>

<header class="top">
    <img src="./icon.svg" width="28" height="28" alt="" />
    <h1>webxdc apps</h1>
    {#if c.status === "standalone" || c.canAdd}
        <button class="primary" onclick={() => c.open({ name: "add" })}>{c.status === "standalone" ? "Try an app" : "Add app"}</button>
    {/if}
</header>

{#if c.status === "ready" && c.identity === "fixing"}
    <p class="note" role="status">Setting up: the widget reloads in a moment so that it knows who is using it.</p>
{:else if c.status === "ready" && c.identity === "missing"}
    <p class="note warn" role="alert">
        This widget does not know who you are, so apps cannot start (everyone would look like the same person). Someone who may
        change room settings can fix it by opening the widget once, or by adding it again with:
        <code class="select">{c.addWidgetLine}</code>
    </p>
{/if}

{#if c.status === "connecting"}
    <p class="muted">Connecting to the room…</p>
{:else if c.status === "standalone"}
    <p class="note">
        Not in a Matrix room. You can try apps here; their updates stay on this page. Add this widget to a room to share apps
        with everyone in it.
    </p>
{:else}
    {#if !c.canAdd}
        <p class="note small muted">You can play the apps in this room. Adding apps needs the right to change room settings.</p>
    {/if}
    {#if c.encrypted}
        <p class="note small">
            What people do in an app is end-to-end encrypted. The list of apps, their names and the app files are not, like all room
            state.
        </p>
    {/if}
{/if}

{#if c.status !== "connecting"}
    {#if c.instances.length === 0}
        <div class="empty">
            {#if c.status === "standalone"}
                Pick an app from the webxdc catalog or an .xdc file.
            {:else}
                No apps in this room yet.{#if c.canAdd}
                    Add one from the webxdc catalog, a file or a link.{/if}
            {/if}
        </div>
    {:else}
        <div class="apps">
            {#each c.instances as inst (inst.id)}
                <article class="app-card">
                    <AppIcon src={icons[inst.id]} name={inst.content.name} />
                    <div class="body">
                        {#if renaming === inst.id}
                            <form class="row" onsubmit={(e) => (e.preventDefault(), saveRename(inst.id))}>
                                <input type="text" class="grow" bind:value={newName} aria-label="App name" maxlength="100" />
                                <button class="primary" type="submit">Save</button>
                                <button type="button" class="ghost" onclick={() => (renaming = null)}>Cancel</button>
                            </form>
                        {:else}
                            <div class="name ellipsis" title={inst.content.name}>{inst.content.name}</div>
                        {/if}
                        <div class="small muted ellipsis">
                            {c.caption(inst.id) || `added by ${c.room.displayName(inst.sender)}`}
                        </div>
                        <menu class="actions">
                            <button class="primary" onclick={() => c.open({ name: "player", instance: inst.id })} disabled={!c.canPlay}>Start</button>
                            {#if c.canPin}
                                <button class="ghost" onclick={() => togglePin(inst)} title="Show this app as its own widget in the room">
                                    {c.isPinned(inst.id) ? "Unpin" : "Pin"}
                                </button>
                            {/if}
                            {#if c.canAdd}
                                <button class="ghost" onclick={() => startRename(inst)}>Rename</button>
                                {#if confirmRemove === inst.id}
                                    <button class="danger" onclick={() => remove(inst.id)}>Remove for everyone</button>
                                {:else}
                                    <button class="ghost danger" onclick={() => (confirmRemove = inst.id)}>Remove</button>
                                {/if}
                            {/if}
                        </menu>
                    </div>
                </article>
            {/each}
        </div>
    {/if}
{/if}

<p class="small muted">
    webxdc apps run in an isolated frame without internet access. They share state only through this room.
    <a href="https://webxdc.org" target="_blank" rel="noopener noreferrer">About webxdc</a>
</p>
