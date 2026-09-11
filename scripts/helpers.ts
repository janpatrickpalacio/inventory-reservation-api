import { parseArgs } from 'node:util';

// Shared helpers for the scripts in this folder.
// The scripts talk to a RUNNING API over HTTP, like a real client. That way they test the
// whole system together: Express, Supabase, and the locking inside PostgreSQL.

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:3000' },
    'item-id': { type: 'string' },
    'no-pause': { type: 'boolean', default: false },
  },
});

export const options = {
  baseUrl: values['base-url'].replace(/\/+$/, ''),
  itemId: values['item-id'],
  noPause: values['no-pause'],
};

export interface ApiResponse {
  status: number; // 0 means the request never got an HTTP response (network error)
  body: any;
}

// Sends one request. A network error returns status 0 instead of throwing, so a script
// counts it as a failure. It is never mistaken for a normal 409 response.
export async function callApi(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  try {
    const response = await fetch(options.baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  } catch (error) {
    return { status: 0, body: { network_error: String(error) } };
  }
}

let failedChecks = 0;

export function check(passed: boolean, description: string) {
  console.log(`    ${passed ? 'PASS' : 'FAIL'}  ${description}`);
  if (!passed) {
    failedChecks += 1;
  }
}

export function printResult() {
  if (failedChecks === 0) {
    console.log('\nAll checks passed.');
  } else {
    console.log(`\n${failedChecks} check(s) FAILED.`);
    process.exitCode = 1;
  }
}

export interface Quantities {
  total: number;
  available: number;
  held: number;
  confirmed: number;
}

export function formatQuantities(quantities: Quantities) {
  const { total, available, held, confirmed } = quantities;
  return `total ${total} | available ${available} | held ${held} | confirmed ${confirmed}`;
}

export async function getQuantities(itemId: string): Promise<Quantities> {
  const { status, body } = await callApi('GET', `/v1/items/${itemId}`);
  if (status !== 200) {
    throw new Error(`GET /v1/items/${itemId} returned ${status}: ${JSON.stringify(body)}`);
  }
  return {
    total: body.total_quantity,
    available: body.available_quantity,
    held: body.held_quantity,
    confirmed: body.confirmed_quantity,
  };
}

export async function checkQuantities(itemId: string, expected: Quantities) {
  const actual = await getQuantities(itemId);
  const matches = formatQuantities(actual) === formatQuantities(expected);
  check(matches, `stock is ${formatQuantities(expected)}${matches ? '' : `  (got ${formatQuantities(actual)})`}`);
}

// Setup helpers. If setup fails, the script stops, because the checks after it would mean nothing.
export async function createItem(name: string, quantity: number): Promise<{ id: string }> {
  const { status, body } = await callApi('POST', '/v1/items', { name, initial_quantity: quantity });
  if (status !== 201) {
    throw new Error(`Could not create item: ${status} ${JSON.stringify(body)}`);
  }
  return body;
}

export async function createReservation(
  itemId: string,
  customerId: string,
  quantity: number,
): Promise<{ id: string; created_at: string; expires_at: string }> {
  const { status, body } = await callApi('POST', '/v1/reservations', {
    item_id: itemId,
    customer_id: customerId,
    quantity,
  });
  if (status !== 201) {
    throw new Error(`Could not create reservation: ${status} ${JSON.stringify(body)}`);
  }
  return body;
}

export function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
