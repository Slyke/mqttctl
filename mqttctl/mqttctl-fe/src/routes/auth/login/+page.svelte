<script lang="ts">
  export let data: {
    redirectTo: string;
    auth: {
      localEnabled: boolean;
      oidcEnabled: boolean;
      headerEnabled: boolean;
    };
    form?: {
      message?: string;
      username?: string;
      redirectTo?: string;
    };
  };
  export let form: {
    message?: string;
    username?: string;
    redirectTo?: string;
  } | null;
</script>

<div class="login-shell">
  <div class="panel login-card stack">
    <div class="stack-tight">
      <h1 class="page-title">mqttctl</h1>
      <p class="muted">Mosquitto Dynamic Security, MQTT Config, Audit, and Snapshots in one local-first control plane.</p>
    </div>

    {#if form?.message}
      <div class="badge tone-danger">{form.message}</div>
    {/if}

    {#if data.auth.localEnabled}
      <form method="POST" class="stack">
        <input type="hidden" name="provider" value="local" />
        <input type="hidden" name="redirectTo" value={data.redirectTo} />
        <label class="stack-tight">
          <span class="muted">Username</span>
          <input name="username" autocomplete="username" value={form?.username ?? ''} />
        </label>
        <label class="stack-tight">
          <span class="muted">Password</span>
          <input name="password" type="password" autocomplete="current-password" />
        </label>
        <div class="form-actions">
          <button class="button-start" type="submit">Sign In</button>
        </div>
      </form>
    {/if}

    {#if data.auth.oidcEnabled}
      <form method="POST">
        <input type="hidden" name="provider" value="oidc" />
        <input type="hidden" name="redirectTo" value={data.redirectTo} />
        <button class="button-mid" type="submit">Sign In With OIDC</button>
      </form>
    {/if}

    {#if data.auth.headerEnabled}
      <p class="subtle">Trusted Header Auth is enabled. If you’re coming through the configured proxy, refreshing this page should sign you in automatically.</p>
    {/if}
  </div>
</div>
