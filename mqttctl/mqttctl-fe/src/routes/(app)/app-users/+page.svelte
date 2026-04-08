<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { apiRequest } from '$lib/stores/api';
  import { formatDisplayCode } from '$lib/strings/display';

  export let data: {
    users: Array<{
      id: string;
      username: string;
      email: string | null;
      role: string;
      authSource: string;
      disabled: boolean;
    }>;
  };

  let message = '';
  let error = '';

  let createUsername = '';
  let createEmail = '';
  let createRole = 'viewer';
  let createPassword = '';
  let passwordResetUserId: string | null = null;

  const isLocalUser = (user: typeof data.users[number]) => user.authSource === 'local';

  const togglePasswordReset = (userId: string) => {
    passwordResetUserId = passwordResetUserId === userId ? null : userId;
  };

  const createUser = async () => {
    error = '';
    message = '';

    try {
      await apiRequest({
        url: '/api/users',
        method: 'POST',
        body: {
          username: createUsername,
          email: createEmail || null,
          password: createPassword || null,
          role: createRole
        }
      });
      createUsername = '';
      createEmail = '';
      createPassword = '';
      createRole = 'viewer';
      message = 'User created.';
      await invalidateAll();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Failed creating user.';
    }
  };

  const updateUser = async (user: typeof data.users[number], form: HTMLFormElement) => {
    error = '';
    message = '';
    const formData = new FormData(form);

    try {
      await apiRequest({
        url: `/api/users/${user.id}`,
        method: 'PATCH',
        body: {
          email: String(formData.get('email') ?? '') || null,
          role: String(formData.get('role') ?? user.role),
          disabled: isLocalUser(user) && formData.get('disabled') === 'on',
          password: isLocalUser(user) ? String(formData.get('password') ?? '') || null : null
        }
      });
      if (passwordResetUserId === user.id) {
        passwordResetUserId = null;
      }
      message = `Updated ${user.username}.`;
      await invalidateAll();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Failed updating user.';
    }
  };

  const deleteUser = async (user: typeof data.users[number]) => {
    if (!confirm(`Delete App User ${user.username}?`)) return;
    error = '';
    message = '';

    try {
      await apiRequest({
        url: `/api/users/${user.id}`,
        method: 'DELETE'
      });
      if (passwordResetUserId === user.id) {
        passwordResetUserId = null;
      }
      message = `Deleted ${user.username}.`;
      await invalidateAll();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Failed deleting user.';
    }
  };
</script>

<section class="stack">
  <div class="page-header">
    <div>
      <h1 class="page-title">App Users</h1>
      <p class="muted">App-owned admins, RBAC roles, and local-auth password reset/session invalidation controls.</p>
    </div>
  </div>

  {#if message}
    <div class="badge tone-mid">{message}</div>
  {/if}
  {#if error}
    <div class="badge tone-danger">{error}</div>
  {/if}

  <article class="panel stack">
    <h2>Create User</h2>
    <form class="form-grid" on:submit|preventDefault={createUser}>
      <label class="stack-tight">
        <span class="muted">Username</span>
        <input bind:value={createUsername} />
      </label>
      <label class="stack-tight">
        <span class="muted">Email</span>
        <input bind:value={createEmail} type="email" />
      </label>
      <label class="stack-tight">
        <span class="muted">Role</span>
        <select bind:value={createRole}>
          <option value="viewer">{formatDisplayCode('viewer')}</option>
          <option value="operator">{formatDisplayCode('operator')}</option>
          <option value="security_admin">{formatDisplayCode('security_admin')}</option>
          <option value="broker_admin">{formatDisplayCode('broker_admin')}</option>
          <option value="super_admin">{formatDisplayCode('super_admin')}</option>
        </select>
      </label>
      <label class="stack-tight">
        <span class="muted">Password</span>
        <input bind:value={createPassword} type="password" />
      </label>
      <div class="form-actions">
        <button class="button-start" type="submit">Create User</button>
      </div>
    </form>
  </article>

  <article class="panel stack">
    <h2>Users</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>User</th>
            <th>Auth</th>
            <th>Role</th>
            <th>Email</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each data.users as user}
            <tr>
              <td>
                <strong>{user.username}</strong>
              </td>
              <td>{formatDisplayCode(user.authSource)}</td>
              <td colspan="4">
                <form class="stack-tight app-user-form" on:submit|preventDefault={(event) => updateUser(user, event.currentTarget as HTMLFormElement)}>
                  <div class="form-grid app-user-grid">
                    <label class="stack-tight">
                      <span class="muted">Role</span>
                      <select name="role" value={user.role}>
                        <option value="viewer">{formatDisplayCode('viewer')}</option>
                        <option value="operator">{formatDisplayCode('operator')}</option>
                        <option value="security_admin">{formatDisplayCode('security_admin')}</option>
                        <option value="broker_admin">{formatDisplayCode('broker_admin')}</option>
                        <option value="super_admin">{formatDisplayCode('super_admin')}</option>
                      </select>
                    </label>
                    <label class="stack-tight">
                      <span class="muted">Email</span>
                      <input name="email" type="email" value={user.email ?? ''} />
                    </label>
                    {#if isLocalUser(user)}
                      <label class="stack-tight">
                        <span class="muted">Reset Password</span>
                        {#if passwordResetUserId === user.id}
                          <input name="password" type="password" placeholder="New password" />
                          <button class="button-mid" type="button" on:click={() => togglePasswordReset(user.id)}>Hide Reset Password</button>
                        {:else}
                          <button class="button-mid" type="button" on:click={() => togglePasswordReset(user.id)}>Reset Password</button>
                        {/if}
                      </label>
                    {/if}
                  </div>
                  <div class="app-user-footer">
                    {#if isLocalUser(user)}
                      <label class="app-user-status">
                        <span class="muted">Disabled</span>
                        <input name="disabled" type="checkbox" checked={user.disabled} />
                      </label>
                    {:else}
                      <div class="muted">
                        {formatDisplayCode(user.authSource)} accounts do not support password reset or disable.
                      </div>
                    {/if}
                    <div class="form-actions app-user-actions">
                      <button class="button-mid" type="submit">Save</button>
                      <button class="button-danger" type="button" on:click={() => deleteUser(user)}>Delete</button>
                    </div>
                  </div>
                </form>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </article>
</section>

<style>
  .app-user-form {
    gap: var(--space-4);
  }

  .app-user-grid {
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  }

  .app-user-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .app-user-status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
  }

  .app-user-actions {
    justify-content: flex-end;
  }

  @media (max-width: 820px) {
    .app-user-footer {
      align-items: flex-start;
      justify-content: flex-start;
    }

    .app-user-actions {
      justify-content: flex-start;
    }
  }
</style>
