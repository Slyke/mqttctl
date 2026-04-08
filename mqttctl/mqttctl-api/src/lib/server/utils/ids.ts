import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const createCorrelationId = () => randomUUID();

export const createOpaqueToken = ({ bytes = 24 }: { bytes?: number } = {}) => randomBytes(bytes).toString('base64url');

export const hashToken = ({ value }: { value: string }) => createHash('sha256').update(value).digest('hex');

