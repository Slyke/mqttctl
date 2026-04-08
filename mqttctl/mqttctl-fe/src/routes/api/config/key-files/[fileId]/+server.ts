import { Buffer } from 'node:buffer';
import { createAppError } from '$server/logging/errors';
import { handleApiError } from '$server/http';
import { requireCapability } from '$server/permissions';
import { managedBrokerKeyFileIds, type ManagedBrokerKeyFileId } from '$lib/types';

const sanitizeFileName = (value: string) => value.replace(/["\r\n]/g, '_');

const parseManagedKeyFileId = ({ value, correlationId }: { value: string; correlationId: string | null }) => {
  if (managedBrokerKeyFileIds.includes(value as ManagedBrokerKeyFileId)) {
    return value as ManagedBrokerKeyFileId;
  }

  throw createAppError({
    caller: 'api::config::key-files::parseManagedKeyFileId',
    reason: 'Requested managed broker key file is invalid.',
    errorKey: 'INPUT_INVALID',
    correlationId,
    status: 400,
    context: { fileId: value }
  });
};

export const GET = async (event) => {
  try {
    requireCapability({
      user: event.locals.currentUser,
      capability: 'read',
      correlationId: event.locals.correlationId
    });

    const fileId = parseManagedKeyFileId({
      value: event.params.fileId,
      correlationId: event.locals.correlationId
    });
    const file = await event.locals.appContext.brokerConfig.readManagedKeyFile({
      fileId,
      correlationId: event.locals.correlationId
    });
    const safeFileName = sanitizeFileName(file.fileName);

    return new Response(file.content, {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${safeFileName}"`,
        'content-length': String(Buffer.byteLength(file.content, 'utf8')),
        'content-type': 'application/octet-stream'
      }
    });
  } catch (error) {
    return handleApiError({ event, error });
  }
};
