import { redirect } from '@sveltejs/kit';

export const load = async ({ locals }) => {
  if (locals.currentUser) {
    throw redirect(303, `${locals.appContext.runtimeConfig.config.basePath}/dashboard`);
  }

  throw redirect(303, `${locals.appContext.runtimeConfig.config.basePath}/auth/login`);
};

