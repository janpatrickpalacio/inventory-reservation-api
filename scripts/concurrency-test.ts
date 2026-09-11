// Concurrency test. Sends overlapping requests to a RUNNING API and checks the results.
//
// Usage:
//   npm run test:concurrency                                     (http://localhost:3000)
//   npm run test:concurrency -- --base-url https://your-app.vercel.app
//
// Run it with the normal hold time (RESERVATION_TTL_SECONDS=600), so no reservation
// expires while the test is running. Each scenario creates its own new item.

import {
  type ApiResponse,
  callApi,
  check,
  checkQuantities,
  createItem,
  createReservation,
  options,
  printResult,
} from './helpers';

// Starts `count` requests at the same time, then waits for all of them.
// Every fetch starts before we wait for the first answer, so the requests overlap on the server.
function sendAtTheSameTime(count: number, sendOne: (index: number) => Promise<ApiResponse>) {
  return Promise.all(Array.from({ length: count }, (_, index) => sendOne(index)));
}

async function testOverselling() {
  console.log('\n[1] 20 overlapping reservations of 1 unit, for an item with 5 units');
  const item = await createItem('Concurrency test - overselling', 5);
  console.log(`    item id: ${item.id}`);

  const responses = await sendAtTheSameTime(20, (index) =>
    callApi('POST', '/v1/reservations', { item_id: item.id, customer_id: `customer-${index + 1}`, quantity: 1 }),
  );

  const created = responses.filter((r) => r.status === 201).length;
  const outOfStock = responses.filter((r) => r.status === 409 && r.body?.error?.code === 'INSUFFICIENT_STOCK').length;
  const other = responses.length - created - outOfStock;

  check(created === 5, `5 requests got 201 Created (got ${created})`);
  check(outOfStock === 15, `15 requests got 409 INSUFFICIENT_STOCK (got ${outOfStock})`);
  check(other === 0, `no other responses, such as 500 or network errors (got ${other})`);
  await checkQuantities(item.id, { total: 5, available: 0, held: 5, confirmed: 0 });
}

async function testRepeatedConfirm() {
  console.log('\n[2] The same confirm request, sent 10 times at the same time');
  const item = await createItem('Concurrency test - repeated confirm', 5);
  const reservation = await createReservation(item.id, 'customer-confirm', 2);
  console.log(`    item id: ${item.id}`);
  console.log(`    reservation id: ${reservation.id} (2 units)`);

  const responses = await sendAtTheSameTime(10, () => callApi('POST', `/v1/reservations/${reservation.id}/confirm`));

  const confirmed = responses.filter((r) => r.status === 200 && r.body?.status === 'CONFIRMED').length;
  const confirmedAtValues = new Set(responses.map((r) => r.body?.confirmed_at));

  check(confirmed === 10, `all 10 requests got 200 with status CONFIRMED (got ${confirmed})`);
  check(
    confirmedAtValues.size === 1,
    `all responses show the same confirmed_at, so it was confirmed once (different values: ${confirmedAtValues.size})`,
  );
  await checkQuantities(item.id, { total: 5, available: 3, held: 0, confirmed: 2 });
}

async function testRepeatedCancel() {
  console.log('\n[3] The same cancel request, sent 10 times at the same time');
  const item = await createItem('Concurrency test - repeated cancel', 5);
  const reservation = await createReservation(item.id, 'customer-cancel', 2);
  console.log(`    item id: ${item.id}`);
  console.log(`    reservation id: ${reservation.id} (2 units)`);

  const responses = await sendAtTheSameTime(10, () => callApi('POST', `/v1/reservations/${reservation.id}/cancel`));

  const cancelled = responses.filter((r) => r.status === 200 && r.body?.status === 'CANCELLED').length;
  const cancelledAtValues = new Set(responses.map((r) => r.body?.cancelled_at));

  check(cancelled === 10, `all 10 requests got 200 with status CANCELLED (got ${cancelled})`);
  check(
    cancelledAtValues.size === 1,
    `all responses show the same cancelled_at, so it was cancelled once (different values: ${cancelledAtValues.size})`,
  );
  // Available must be exactly 5 again: not 7, which would mean the 2 units were released twice.
  await checkQuantities(item.id, { total: 5, available: 5, held: 0, confirmed: 0 });
}

async function testConfirmVersusCancel() {
  console.log('\n[4] 5 confirm and 5 cancel requests for the same reservation, at the same time');
  const item = await createItem('Concurrency test - confirm vs cancel', 5);
  const reservation = await createReservation(item.id, 'customer-race', 2);
  console.log(`    item id: ${item.id}`);
  console.log(`    reservation id: ${reservation.id} (2 units)`);

  // Even positions confirm, odd positions cancel, so the two kinds of request are mixed.
  const responses = await sendAtTheSameTime(10, (index) =>
    callApi('POST', `/v1/reservations/${reservation.id}/${index % 2 === 0 ? 'confirm' : 'cancel'}`),
  );
  const confirmResponses = responses.filter((_, index) => index % 2 === 0);
  const cancelResponses = responses.filter((_, index) => index % 2 === 1);

  const confirmWon = confirmResponses.some((r) => r.status === 200);
  const cancelWon = cancelResponses.some((r) => r.status === 200);
  check(confirmWon !== cancelWon, `exactly one action won (confirm won: ${confirmWon}, cancel won: ${cancelWon})`);

  if (confirmWon) {
    check(
      confirmResponses.every((r) => r.status === 200),
      'confirm won: every confirm request got 200',
    );
    check(
      cancelResponses.every((r) => r.status === 409 && r.body?.error?.code === 'ALREADY_CONFIRMED'),
      'every cancel request got 409 ALREADY_CONFIRMED',
    );
    await checkQuantities(item.id, { total: 5, available: 3, held: 0, confirmed: 2 });
  } else {
    check(
      cancelResponses.every((r) => r.status === 200),
      'cancel won: every cancel request got 200',
    );
    check(
      confirmResponses.every((r) => r.status === 409 && r.body?.error?.code === 'ALREADY_CANCELLED'),
      'every confirm request got 409 ALREADY_CANCELLED',
    );
    await checkQuantities(item.id, { total: 5, available: 5, held: 0, confirmed: 0 });
  }
}

async function main() {
  console.log(`Concurrency test against ${options.baseUrl}`);
  await testOverselling();
  await testRepeatedConfirm();
  await testRepeatedCancel();
  await testConfirmVersusCancel();
  printResult();
}

main().catch((error) => {
  console.error('\nThe test stopped because of an error:', error);
  process.exitCode = 1;
});
