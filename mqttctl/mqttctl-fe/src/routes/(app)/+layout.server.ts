import { redirect } from '@sveltejs/kit';
import { buildAppNavItems } from '$lib/server/app-navigation';

export const load = async ({ locals, url }) => {
  if (!locals.currentUser) {
    const redirectTo = `${url.pathname}${url.search}`;
    throw redirect(303, `${locals.appContext.runtimeConfig.config.basePath}/auth/login?redirectTo=${encodeURIComponent(redirectTo)}`);
  }

  return {
    currentUser: locals.currentUser,
    basePath: locals.appContext.runtimeConfig.config.basePath,
    navItems: buildAppNavItems({ user: locals.currentUser }),
    buildLabel: locals.appContext.buildInfo.label
  };
};
