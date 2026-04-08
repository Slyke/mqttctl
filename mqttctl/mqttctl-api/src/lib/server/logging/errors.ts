import catalog from '../../../errors.json';

type ErrorCatalog = Record<string, string>;

export class AppError extends Error {
  errorKey: string;
  errorCode: string;
  caller: string;
  correlationId: string | null;
  context: unknown;
  status: number;
  override cause: unknown;
  errorChain: Array<{ errorKey: string; errorCode: string; caller: string; reason: string }>;

  constructor({
    caller,
    reason,
    errorKey,
    correlationId = null,
    context = null,
    status = 500,
    cause = null
  }: {
    caller: string;
    reason: string;
    errorKey: string;
    correlationId?: string | null;
    context?: unknown;
    status?: number;
    cause?: unknown;
  }) {
    super(reason);
    this.name = 'AppError';
    this.errorKey = errorKey;
    this.errorCode = resolveErrorCode({ errorKey });
    this.caller = caller;
    this.correlationId = correlationId;
    this.context = context;
    this.status = status;
    this.cause = cause;
    this.errorChain = [
      {
        errorKey: this.errorKey,
        errorCode: this.errorCode,
        caller: this.caller,
        reason
      }
    ];
  }
}

export const resolveErrorCode = ({ errorKey }: { errorKey: string }) => {
  const errorCatalog = catalog as ErrorCatalog;
  return errorCatalog[errorKey] ?? errorCatalog.ERR_UNKNOWN ?? 'FFFFFFFFFFFFFFFF';
};

export const createAppError = ({
  caller,
  reason,
  errorKey,
  correlationId = null,
  context = null,
  status = 500,
  cause = null
}: {
  caller: string;
  reason: string;
  errorKey: string;
  correlationId?: string | null;
  context?: unknown;
  status?: number;
  cause?: unknown;
}) => {
  if (cause instanceof AppError) {
    const wrapped = new AppError({ caller, reason, errorKey, correlationId, context, status, cause });
    wrapped.errorChain = [wrapped.errorChain[0]!, ...cause.errorChain];
    return wrapped;
  }

  return new AppError({ caller, reason, errorKey, correlationId, context, status, cause });
};

export const toErrorBody = ({ error }: { error: unknown }) => {
  if (error instanceof AppError) {
    return {
      ok: false as const,
      errorKey: error.errorKey,
      errorCode: error.errorCode,
      reason: error.message,
      correlationId: error.correlationId,
      details: error.context ?? undefined
    };
  }

  return {
    ok: false as const,
    errorKey: 'ERR_UNKNOWN',
    errorCode: resolveErrorCode({ errorKey: 'ERR_UNKNOWN' }),
    reason: error instanceof Error ? error.message : 'Unknown error',
    correlationId: null
  };
};
