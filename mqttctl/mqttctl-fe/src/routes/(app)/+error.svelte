<script lang="ts">
  export let error: Partial<App.Error> | null = null;
  export let status = 500;

  const resolveTitle = ({ status }: { status: number }) => {
    if (status === 401) return 'Authentication Required';
    if (status === 403) return 'Access Denied';
    if (status === 404) return 'Page Not Found';
    return 'Page Failed To Load';
  };

  const fallbackMessage = 'The requested page could not be loaded.';
</script>

<section class="stack">
  <div class="page-header">
    <div>
      <h1 class="page-title">{resolveTitle({ status })}</h1>
      <p class="muted">{error?.message ?? fallbackMessage}</p>
    </div>
  </div>

  <article class="panel stack">
    <div class="badge tone-danger">HTTP {status}</div>

    {#if error?.errorCode}
      <div class="subtle">Error code: {error.errorCode}</div>
    {/if}

    {#if error?.correlationId}
      <div class="subtle">Correlation ID: {error.correlationId}</div>
    {/if}
  </article>
</section>
