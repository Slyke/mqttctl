export const load = async ({ locals }) => ({
  currentUser: locals.currentUser,
  correlationId: locals.correlationId,
  ui: {
    theme: locals.appContext.runtimeConfig.config.ui.defaultTheme,
    font: locals.appContext.runtimeConfig.config.ui.defaultFont,
    overrideCssEnabled: Boolean(locals.appContext.runtimeConfig.uiOverrideCssPath)
  }
});

