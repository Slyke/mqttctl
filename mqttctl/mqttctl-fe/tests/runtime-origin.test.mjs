import assert from 'node:assert/strict';
import test from 'node:test';
import { createOriginMiddleware } from '../server.mjs';

test('fixed ORIGIN overrides forged host and protocol headers', () => {
  const request = {
    headers: {
      host: 'untrusted.example',
      'x-forwarded-proto': 'http',
      'x-mqttctl-internal-protocol': 'http',
      'x-mqttctl-internal-host': 'untrusted.example'
    },
    socket: {}
  };
  createOriginMiddleware({ origin: 'https://mqtt.example:8443' })(request);
  assert.equal(request.headers['x-mqttctl-internal-protocol'], 'https');
  assert.equal(request.headers['x-mqttctl-internal-host'], 'mqtt.example:8443');
});

test('direct HTTP ignores unconfigured forwarding headers', () => {
  const request = {
    headers: { 'x-forwarded-proto': 'https', 'x-mqttctl-internal-protocol': 'https' },
    socket: {}
  };
  createOriginMiddleware()(request);
  assert.equal(request.headers['x-mqttctl-internal-protocol'], 'http');
});

test('explicitly configured proxy protocol is preserved', () => {
  const request = { headers: { 'x-forwarded-proto': 'https' }, socket: {} };
  createOriginMiddleware({ protocolHeader: 'X-Forwarded-Proto' })(request);
  assert.equal(request.headers['x-mqttctl-internal-protocol'], 'https');
});

test('encrypted connections use HTTPS without forwarded headers', () => {
  const request = { headers: {}, socket: { encrypted: true } };
  createOriginMiddleware()(request);
  assert.equal(request.headers['x-mqttctl-internal-protocol'], 'https');
});

test('non-HTTP origins are rejected before starting the server', () => {
  assert.throws(() => createOriginMiddleware({ origin: 'file:///tmp/app' }), /HTTP or HTTPS/);
});
