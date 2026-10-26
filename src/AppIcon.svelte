<script lang="ts">
    /* An app's icon: an image URL if there is one, else its initial. */
    let { src = null, name, small = false }: { src?: string | null; name: string; small?: boolean } = $props();
    let failed = $state(false);
</script>

{#if src && !failed}
    <img class="icon" class:small {src} alt="" onerror={() => (failed = true)} />
{:else}
    <span class="icon" class:small aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "?"}</span>
{/if}
