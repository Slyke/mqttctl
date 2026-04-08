import type { AuthenticatedUser, AuthMethod, UserRole } from '$lib/types';

export interface AuthSessionUser extends AuthenticatedUser {
  sessionId: string;
  sessionExpiresAt: string;
}

export interface LocalLoginInput {
  username: string;
  password: string;
}

export interface CreateUserInput {
  username: string;
  email?: string | null;
  password?: string | null;
  role: UserRole;
  authSource?: AuthMethod;
  externalSubject?: string | null;
}

export type { AuthenticatedUser };

