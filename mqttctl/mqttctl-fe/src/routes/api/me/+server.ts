import { ok } from '$server/http';

export const GET = async ({ locals }) => ok({
  data: {
    currentUser: locals.currentUser,
    correlationId: locals.correlationId
  }
});

