import http from 'node:http';
import { pathToFileURL } from 'node:url';

const internalProtocolHeader = 'x-mqttctl-internal-protocol';
const internalHostHeader = 'x-mqttctl-internal-host';

export function createOriginMiddleware({ origin, protocolHeader } = {}) {
  const fixedOrigin = origin ? new URL(origin) : null;
  if (fixedOrigin && !['http:', 'https:'].includes(fixedOrigin.protocol)) {
    throw new Error('ORIGIN must be an HTTP or HTTPS URL.');
  }
  const trustedProtocolHeader = protocolHeader?.toLowerCase();

  return (request) => {
    // Overwrite the private headers on every request so clients cannot forge
    // the origin used by adapter-node's CSRF checks.
    request.headers[internalProtocolHeader] = fixedOrigin
      ? fixedOrigin.protocol.slice(0, -1)
      : (trustedProtocolHeader && request.headers[trustedProtocolHeader])
        || (request.socket.encrypted ? 'https' : 'http');
    if (fixedOrigin) request.headers[internalHostHeader] = fixedOrigin.host;
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const applyOrigin = createOriginMiddleware({
    origin: process.env.ORIGIN,
    protocolHeader: process.env.PROTOCOL_HEADER
  });

  // Adapter-node 6 removed ORIGIN and otherwise assumes HTTPS. Keep the
  // existing runtime setting and support direct local HTTP without changing
  // the adapter's server lifecycle, request limits, or shutdown handling.
  process.env.PROTOCOL_HEADER = internalProtocolHeader;
  if (process.env.ORIGIN) {
    process.env.HOST_HEADER = internalHostHeader;
    delete process.env.PORT_HEADER;
  }

  const createServer = http.createServer.bind(http);
  http.createServer = (...args) => {
    const server = createServer(...args);
    server.prependListener('request', applyOrigin);
    return server;
  };

  await import('./build/index.js');
}
