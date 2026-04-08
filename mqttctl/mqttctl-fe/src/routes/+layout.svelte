<script lang="ts">
  import { browser } from '$app/environment';
  import '$styles/app.css';

  export let data: App.PageData;

  if (browser) {
    document.documentElement.dataset.theme = data.ui?.theme ?? 'dark';
    document.documentElement.dataset.font = data.ui?.font ?? 'ui-mono';
  }
</script>

<svelte:head>
  {#if data.ui?.overrideCssEnabled}
    <link rel="stylesheet" href="/instance-overrides.css" />
  {/if}
</svelte:head>

<slot />

