import { readFile } from 'node:fs/promises';
import { text } from '@sveltejs/kit';

export const GET = async ({ locals }) => {
  const overridePath = locals.appContext.runtimeConfig.uiOverrideCssPath;
  if (!overridePath) {
    return new Response(null, { status: 404 });
  }

  try {
    const css = await readFile(overridePath, 'utf8');
    return text(css, {
      headers: {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'no-cache'
      }
    });
  } catch {
    return new Response(null, { status: 404 });
  }
};

