<script lang="ts">
  import { page } from '$app/state';
  import { formatDisplayCode } from '$lib/strings/display';

  export let data: {
    currentUser: {
      username: string;
      role: string;
      authSource: string;
    };
    basePath: string;
    navItems: Array<{
      href: string;
      label: string;
    }>;
    buildLabel: string;
  };
</script>

<div class="app-shell">
  <aside class="app-sidebar">
    <div class="stack-tight">
      <div class="badge tone-start">mqttctl</div>
      <div>
        <strong>{data.currentUser.username}</strong>
        <div class="muted">{formatDisplayCode(data.currentUser.role)} via {formatDisplayCode(data.currentUser.authSource)}</div>
      </div>
    </div>

    <nav class="nav-list">
      {#each data.navItems as item}
        {@const target = `${data.basePath}${item.href}`}
        <a class:active={page.url.pathname === target} class="nav-link" href={target}>
          <span>{item.label}</span>
        </a>
      {/each}
    </nav>

    <div class="app-sidebar-footer stack-tight">
      <form method="POST" action={`${data.basePath}/auth/logout`}>
        <button class="button-danger" type="submit">Logout</button>
      </form>

      <div class="app-sidebar-build stack-tight">
        <div class="muted">Build</div>
        <code>{data.buildLabel}</code>
      </div>
    </div>
  </aside>

  <main
    class:app-main-full={page.url.pathname === `${data.basePath}/audit`}
    class:app-main-mqtt={page.url.pathname === `${data.basePath}/mqtt`}
    class:app-main-wide={[
      `${data.basePath}/dashboard`,
      `${data.basePath}/dynsec`,
      `${data.basePath}/mqtt`
    ].includes(page.url.pathname)}
    class="app-main"
  >
    <slot />
  </main>
</div>
