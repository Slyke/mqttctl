import { getHttpApiClientBasePath } from '$server/config/http-api';

export const load = async ({ locals }) => ({
  apiBasePath: getHttpApiClientBasePath({ runtimeConfig: locals.appContext.runtimeConfig }),
  currentUser: locals.currentUser,
  correlationId: locals.correlationId,
  ui: {
    theme: locals.appContext.runtimeConfig.config.ui.defaultTheme,
    font: locals.appContext.runtimeConfig.config.ui.defaultFont,
    overrideCssEnabled: Boolean(locals.appContext.runtimeConfig.uiOverrideCssPath)
  }
});
