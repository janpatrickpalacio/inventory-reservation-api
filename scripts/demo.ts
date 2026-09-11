// Interactive demo for the video. It pauses before each step, so you can explain what happens.
//
// 1. In Swagger (/docs), create a NEW item with 5 units and copy its id.
// 2. Run:  npm run demo -- --item-id <that id>
//    (add --base-url https://your-app.vercel.app to use the deployed API)
//
// Every step is a real HTTP request. The script stops if a response is not what we expect.

import { createInterface } from 'node:readline/promises';
import { callApi, formatQuantities, getQuantities, options } from './helpers';

const terminal = createInterface({ input: process.stdin, output: process.stdout });

async function runStep(
  itemId: string,
  description: string,
  method: string,
  path: string,
  body: unknown,
  expectedStatus: number,
) {
  await terminal.question(`\nPress Enter to ${description}...`);

  console.log(`\n${method} ${path}`);
  if (body !== undefined) {
    console.log(JSON.stringify(body));
  }

  const response = await callApi(method, path, body);
  console.log(`-> HTTP ${response.status}`);
  console.log(JSON.stringify(response.body, null, 2));

  if (response.status !== expectedStatus) {
    throw new Error(`Expected HTTP ${expectedStatus} but got ${response.status}. The demo stops here.`);
  }

  console.log(`Item stock now: ${formatQuantities(await getQuantities(itemId))}`);
  return response.body;
}

async function main() {
  const itemId = options.itemId;
  if (!itemId) {
    console.log('Usage: npm run demo -- --item-id <id of a new item with 5 units>');
    process.exitCode = 1;
    return;
  }

  console.log(`Demo against ${options.baseUrl}`);
  const start = await getQuantities(itemId);
  console.log(`Item ${itemId}: ${formatQuantities(start)}`);
  if (formatQuantities(start) !== formatQuantities({ total: 5, available: 5, held: 0, confirmed: 0 })) {
    throw new Error('The demo needs a NEW item with 5 units: total 5, available 5, held 0, confirmed 0.');
  }

  const reservationA = await runStep(
    itemId,
    'reserve 2 units for customer alice (reservation A)',
    'POST',
    '/v1/reservations',
    { item_id: itemId, customer_id: 'alice', quantity: 2 },
    201,
  );
  const reservationB = await runStep(
    itemId,
    'reserve 1 unit for customer bob (reservation B)',
    'POST',
    '/v1/reservations',
    { item_id: itemId, customer_id: 'bob', quantity: 1 },
    201,
  );
  await runStep(itemId, 'confirm reservation B', 'POST', `/v1/reservations/${reservationB.id}/confirm`, undefined, 200);
  await runStep(
    itemId,
    'confirm reservation B AGAIN (a retry)',
    'POST',
    `/v1/reservations/${reservationB.id}/confirm`,
    undefined,
    200,
  );
  await runStep(itemId, 'cancel reservation A', 'POST', `/v1/reservations/${reservationA.id}/cancel`, undefined, 200);
  await runStep(
    itemId,
    'cancel reservation A AGAIN (a retry)',
    'POST',
    `/v1/reservations/${reservationA.id}/cancel`,
    undefined,
    200,
  );
  await runStep(
    itemId,
    'try to cancel reservation B, which is CONFIRMED',
    'POST',
    `/v1/reservations/${reservationB.id}/cancel`,
    undefined,
    409,
  );

  console.log('\nDemo finished. Expected final stock: total 5 | available 4 | held 0 | confirmed 1');
}

main()
  .catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(() => terminal.close());
