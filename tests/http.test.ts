import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import app from '../src/app';

// Fast tests for the HTTP layer: input validation, the error format, and the documentation routes.
// They use fake settings (tests/test.env) and never reach a database, because every request
// here is rejected before the database is called.
// Database behaviour (locking, retries, expiry) is tested against a real API by the scripts in /scripts.

let server: Server;
let baseUrl: string;

before(async () => {
  server = app.listen(0); // port 0 = any free port
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  server.closeAllConnections();
});

async function send(method: string, path: string, rawBody?: string) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: rawBody === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: rawBody,
  });
  return { status: response.status, body: await response.json() };
}

function assertError(result: { status: number; body: any }, expectedStatus: number, expectedCode: string) {
  assert.equal(result.status, expectedStatus);
  assert.equal(result.body.error.code, expectedCode);
  assert.equal(typeof result.body.error.message, 'string');
}

describe('POST /v1/items', () => {
  test('rejects a missing name', async () => {
    const result = await send('POST', '/v1/items', JSON.stringify({ initial_quantity: 5 }));
    assertError(result, 400, 'VALIDATION_ERROR');
    assert.equal(result.body.error.details.problems[0].field, 'name');
  });

  test('rejects a name with only spaces', async () => {
    const result = await send('POST', '/v1/items', JSON.stringify({ name: '   ', initial_quantity: 5 }));
    assertError(result, 400, 'VALIDATION_ERROR');
  });

  test('rejects quantities that are not whole numbers above 0', async () => {
    for (const badQuantity of [0, -1, 1.5, '5', null, 2147483648]) {
      const result = await send('POST', '/v1/items', JSON.stringify({ name: 'Shirt', initial_quantity: badQuantity }));
      assertError(result, 400, 'VALIDATION_ERROR');
    }
  });

  test('rejects unknown fields', async () => {
    const result = await send('POST', '/v1/items', JSON.stringify({ name: 'Shirt', initial_quantity: 5, price: 10 }));
    assertError(result, 400, 'VALIDATION_ERROR');
  });

  test('rejects a body that is not valid JSON', async () => {
    const result = await send('POST', '/v1/items', '{"name": "Shirt",');
    assertError(result, 400, 'INVALID_JSON');
  });

  test('rejects a request without a body', async () => {
    const result = await send('POST', '/v1/items');
    assertError(result, 400, 'VALIDATION_ERROR');
  });
});

describe('GET /v1/items/:id', () => {
  test('rejects an id that is not a UUID', async () => {
    const result = await send('GET', '/v1/items/not-a-uuid');
    assertError(result, 400, 'VALIDATION_ERROR');
    assert.equal(result.body.error.details.problems[0].field, 'id');
  });
});

describe('POST /v1/reservations', () => {
  const validItemId = '0b7d6a3e-1c2f-4e5a-8b9c-0d1e2f3a4b5c';

  test('rejects an item_id that is not a UUID', async () => {
    const result = await send(
      'POST',
      '/v1/reservations',
      JSON.stringify({ item_id: '123', customer_id: 'alice', quantity: 1 }),
    );
    assertError(result, 400, 'VALIDATION_ERROR');
  });

  test('rejects a quantity of 0', async () => {
    const result = await send(
      'POST',
      '/v1/reservations',
      JSON.stringify({ item_id: validItemId, customer_id: 'alice', quantity: 0 }),
    );
    assertError(result, 400, 'VALIDATION_ERROR');
  });

  test('rejects an empty customer_id', async () => {
    const result = await send(
      'POST',
      '/v1/reservations',
      JSON.stringify({ item_id: validItemId, customer_id: '', quantity: 1 }),
    );
    assertError(result, 400, 'VALIDATION_ERROR');
  });
});

describe('POST /v1/reservations/:id/confirm and /cancel', () => {
  test('confirm rejects an id that is not a UUID', async () => {
    const result = await send('POST', '/v1/reservations/abc/confirm');
    assertError(result, 400, 'VALIDATION_ERROR');
  });

  test('cancel rejects an id that is not a UUID', async () => {
    const result = await send('POST', '/v1/reservations/abc/cancel');
    assertError(result, 400, 'VALIDATION_ERROR');
  });
});

describe('routes and documentation', () => {
  test('an unknown route returns 404 in the same error format', async () => {
    const result = await send('GET', '/v1/does-not-exist');
    assertError(result, 404, 'ROUTE_NOT_FOUND');
  });

  test('GET /openapi.json documents the six required endpoints', async () => {
    const result = await send('GET', '/openapi.json');
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body.paths).sort(), [
      '/v1/items',
      '/v1/items/{id}',
      '/v1/maintenance/expire-reservations',
      '/v1/reservations',
      '/v1/reservations/{id}/cancel',
      '/v1/reservations/{id}/confirm',
    ]);
  });

  test('GET /docs returns the Swagger UI page', async () => {
    const response = await fetch(`${baseUrl}/docs`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /SwaggerUIBundle/);
  });
});
