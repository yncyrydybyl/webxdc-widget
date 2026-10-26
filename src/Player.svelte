<script lang="ts">
    /*
     * Plays one app in the runner frame. The frame is on the runner origin:
     * allow-same-origin there gives the app its own storage and service worker,
     * never access to this widget (a different origin). No allow-popups and no
     * top navigation: links come to the widget, which asks first.
     */
    import { onDestroy } from "svelte";
    import AppIcon from "./AppIcon.svelte";
    import { AppSession } from "./bridge";
    import type { Controller } from "./controller.svelte";
    import { LOCAL_PREFIX, type Instance } from "./room";

    let { c, id, href }: { c: Controller; id: string; href?: string } = $props();

    let frame = $state<HTMLIFrameElement>();
    let status = $state<"waiting" | "loading" | "running" | "error">("waiting");
    let error = $state("");
    let icon = $state<string | null>(null);
    let session: AppSession | null = null;

    const inst = $derived(c.instance(id));
    const local = $derived(id.startsWith(LOCAL_PREFIX));

    // Start once the instance is known (a pinned tile may get its state event a moment after connecting).
    $effect(() => {
        if (session || !frame || !inst || c.status === "connecting" || !c.canPlay) return;
        void start(inst, frame);
    });

    async function start(instance: Instance, el: HTMLIFrameElement): Promise<void> {
        status = "loading";
        void c.room.iconUrl(instance).then((u) => (icon = u));
        const log = await c.room.log(instance.id);
        session = new AppSession({
            room: c.room,
            instance,
            frame: el,
            runner: c.runner,
            selfName: c.selfName,
            href,
            confirmLink: (url) => c.confirmLink(url),
            confirmToChat: (message) => c.confirmToChat(message),
            onError: (m) => {
                error = m;
                status = "error";
            },
            onStatus: (s) => {
                if (status !== "error") status = s;
            },
        });
        await session.start();
        // First time on this device: ask whoever has the app open for its history.
        if (!log.synced && c.status === "ready" && !local) void c.room.requestSync(instance.id);
    }

    onDestroy(() => session?.stop());

    function syncNow(): void {
        void c.room.requestSync(id);
        c.notice = "Asked the room for this app's history. Anyone who has it open will send it.";
    }
</script>

<div class="player">
    <div class="player-bar">
        {#if !c.only}
            <button class="ghost" onclick={() => c.open({ name: "library" })} aria-label="Back to the room's apps">←</button>
        {/if}
        <AppIcon src={icon} name={inst?.content.name ?? "?"} small />
        <div class="title">
            <strong class="ellipsis">{inst?.content.name ?? "webxdc app"}</strong>
            <span class="small muted ellipsis">
                {#if local}Only on this device{:else}{c.caption(id)}{/if}
            </span>
        </div>
        {#if !local && c.status === "ready"}
            <button class="ghost small" onclick={syncNow} title="Ask others in the room for updates this device has not seen">Sync</button>
        {/if}
        {#if inst?.content.source_code_url}
            <a class="button ghost small" href={inst.content.source_code_url} target="_blank" rel="noopener noreferrer">Source</a>
        {/if}
    </div>
    {#if c.links(id).length}
        <ul class="player-links small" aria-label="Messages from the app">
            {#each c.links(id) as link (link.href + link.info)}
                <li>
                    <span class="ellipsis">{c.room.displayName(link.sender)}: {link.info}</span>
                    <button class="ghost small" onclick={() => c.open({ name: "player", instance: id, href: link.href })}>Open</button>
                </li>
            {/each}
        </ul>
    {/if}
    <div class="player-stage">
        <iframe
            bind:this={frame}
            title={inst?.content.name ?? "webxdc app"}
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock"
            allow="fullscreen; autoplay; clipboard-write; accelerometer; gyroscope; magnetometer"
            referrerpolicy="no-referrer"
        ></iframe>
        {#if status !== "running"}
            <div class="overlay">
                {#if status === "error"}
                    <p class="warn" role="alert">{error}</p>
                {:else if c.status === "ready" && !c.canPlay}
                    <p class="warn">This widget does not know who you are, so the app cannot start. Add it again with <code>{c.addWidgetLine}</code></p>
                {:else if !inst && c.status !== "connecting"}
                    <p class="muted">Waiting for the app… If it does not appear, it was removed from the room.</p>
                {:else}
                    <p class="muted" role="status">Starting {inst?.content.name ?? "the app"}…</p>
                {/if}
            </div>
        {/if}
    </div>
</div>
