<script lang="ts">
    import AddApp from "./AddApp.svelte";
    import type { Controller } from "./controller.svelte";
    import Library from "./Library.svelte";
    import Player from "./Player.svelte";
    import { isXdcName } from "./chat";

    let { c }: { c: Controller } = $props();

    const chatFile = $derived(c.chatToConfirm?.message.file);
    const chatText = $derived(c.chatToConfirm?.message.text);
    const appName = $derived(c.view.name === "player" ? (c.instance(c.view.instance)?.content.name ?? "The app") : "The app");
</script>

{#if c.view.name === "player"}
    {#key `${c.view.instance}#${c.view.href ?? ""}`}
        <Player {c} id={c.view.instance} href={c.view.href} />
    {/key}
{:else}
    <main>
        {#if c.view.name === "add"}
            <AddApp {c} />
        {:else}
            <Library {c} />
        {/if}
    </main>
{/if}

{#if c.linkToConfirm}
    <div class="backdrop">
        <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="link-title">
            <h2 id="link-title">Open an external link?</h2>
            <p>{appName} wants to open this address. It leads outside the room and may tell that website that you use the app.</p>
            <div class="url">{c.linkToConfirm}</div>
            <div class="actions">
                <button onclick={() => c.answerLink(false)}>Cancel</button>
                <button class="primary" onclick={() => c.answerLink(true)}>Open</button>
            </div>
        </div>
    </div>
{/if}

{#if c.chatToConfirm}
    <div class="backdrop">
        <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="chat-title">
            <h2 id="chat-title">Send to the room?</h2>
            <p>{appName} prepared a message. Everyone in the room will see it.</p>
            {#if chatFile && isXdcName(chatFile.name)}
                <p>App: <strong>{chatFile.name}</strong> ({Math.ceil(chatFile.blob.size / 1024)} KB), added to the room's apps.</p>
            {:else if chatFile}
                <p>File: <strong>{chatFile.name}</strong> ({Math.ceil(chatFile.blob.size / 1024)} KB)</p>
            {/if}
            {#if chatText}<div class="url">{chatText}</div>{/if}
            {#if c.status !== "ready"}<p class="warn small">Not connected to a room: this cannot be sent.</p>{/if}
            <div class="actions">
                <button onclick={() => c.answerChat(false)}>Cancel</button>
                <button class="primary" onclick={() => c.answerChat(true)} disabled={c.status !== "ready"}>Send</button>
            </div>
        </div>
    </div>
{/if}

{#if c.notice}
    <div class="toast" role="status">
        <span>{c.notice}</span>
        <button onclick={() => (c.notice = "")} aria-label="Dismiss">✕</button>
    </div>
{/if}
