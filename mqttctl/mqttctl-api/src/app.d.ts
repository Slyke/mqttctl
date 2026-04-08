import type { AppContext } from '$server/context';
import type { AuthenticatedUser } from '$server/auth/types';

declare global {
  namespace App {
    interface Locals {
      appContext: AppContext;
      correlationId: string;
      currentUser: AuthenticatedUser | null;
    }
  }
}

export {};
