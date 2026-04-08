import type { AppContext } from '$server/context';
import type { AuthenticatedUser } from '$server/auth/types';

declare global {
  namespace App {
    interface Error {
      message: string;
      correlationId?: string | null;
      errorKey?: string;
      errorCode?: string;
    }

    interface Locals {
      appContext: AppContext;
      correlationId: string;
      currentUser: AuthenticatedUser | null;
    }

    interface PageData {
      currentUser?: AuthenticatedUser | null;
      correlationId?: string;
      ui?: {
        theme: string;
        font: string;
        overrideCssEnabled: boolean;
      };
    }
  }
}

export {};
