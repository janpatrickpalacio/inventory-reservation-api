// Expiry test. Needs a RUNNING API with a SHORT hold time, so the test does not wait 10 minutes.
//
// 1. Start the API with a 5-second hold time:
//      PowerShell:  $env:RESERVATION_TTL_SECONDS=5; npm run dev
//      bash:        RESERVATION_TTL_SECONDS=5 npm run dev
// 2. In another terminal:
//      npm run test:expiry
//
// A variable set in the shell wins over the value in .env.

import {
  callApi,
  check,
  checkQuantities,
  createItem,
  createReservation,
  options,
  printResult,
  sleep,
} from './helpers';

const MAX_HOLD_SECONDS = 30;

async function main() {
  console.log(`Expiry test against ${options.baseUrl}`);

  const item = await createItem('Expiry test item', 5);
  const reservationA = await createReservation(item.id, 'customer-a', 3);
  const reservationB = await createReservation(item.id, 'customer-b', 2);
  console.log(`    item id: ${item.id}`);
  console.log(`    reservation A: ${reservationA.id} (3 units)`);
  console.log(`    reservation B: ${reservationB.id} (2 units)`);

  const holdSeconds = (Date.parse(reservationA.expires_at) - Date.parse(reservationA.created_at)) / 1000;
  if (holdSeconds > MAX_HOLD_SECONDS) {
    console.log(`\nThe API holds reservations for ${holdSeconds} seconds. This test needs ${MAX_HOLD_SECONDS} or less.`);
    console.log('Restart the API with a short hold time. See the instructions at the top of scripts/expiry-test.ts.');
    process.exitCode = 1;
    return;
  }

  console.log('\n[1] Before the deadline: all 5 units are held');
  await checkQuantities(item.id, { total: 5, available: 0, held: 5, confirmed: 0 });
  const blocked = await callApi('POST', '/v1/reservations', { item_id: item.id, customer_id: 'customer-c', quantity: 1 });
  check(
    blocked.status === 409 && blocked.body?.error?.code === 'INSUFFICIENT_STOCK',
    `a new reservation of 1 unit gets 409 INSUFFICIENT_STOCK (got ${blocked.status})`,
  );

  const waitSeconds = holdSeconds + 2;
  console.log(`\n    Waiting ${waitSeconds} seconds for both reservations to pass their deadline...`);
  await sleep(waitSeconds * 1000);

  console.log('\n[2] After the deadline, BEFORE the expire endpoint runs');
  await checkQuantities(item.id, { total: 5, available: 5, held: 0, confirmed: 0 });

  const lateConfirm = await callApi('POST', `/v1/reservations/${reservationA.id}/confirm`);
  check(
    lateConfirm.status === 409 && lateConfirm.body?.error?.code === 'RESERVATION_EXPIRED',
    `confirming reservation A gets 409 RESERVATION_EXPIRED (got ${lateConfirm.status} ${lateConfirm.body?.error?.code})`,
  );
  check(
    lateConfirm.body?.error?.details?.reservation?.status === 'EXPIRED',
    'reservation A is now stored as EXPIRED',
  );
  // The late confirm must not deduct anything.
  await checkQuantities(item.id, { total: 5, available: 5, held: 0, confirmed: 0 });

  console.log('\n[3] The expire endpoint');
  const firstRun = await callApi('POST', '/v1/maintenance/expire-reservations');
  check(
    firstRun.status === 200 && firstRun.body?.expired_count >= 1,
    `the first call returns 200 and expires at least 1 reservation (got ${firstRun.status}, expired_count ${firstRun.body?.expired_count})`,
  );

  const lateCancel = await callApi('POST', `/v1/reservations/${reservationB.id}/cancel`);
  check(
    lateCancel.status === 409 && lateCancel.body?.error?.code === 'RESERVATION_EXPIRED',
    `cancelling reservation B gets 409 RESERVATION_EXPIRED (got ${lateCancel.status} ${lateCancel.body?.error?.code})`,
  );
  check(
    lateCancel.body?.error?.details?.reservation?.expired_at === firstRun.body?.checked_at,
    'reservation B was marked EXPIRED by the expire endpoint (its expired_at equals checked_at)',
  );

  const secondRun = await callApi('POST', '/v1/maintenance/expire-reservations');
  check(secondRun.status === 200, `a second call is safe and returns 200 (expired_count ${secondRun.body?.expired_count})`);
  await checkQuantities(item.id, { total: 5, available: 5, held: 0, confirmed: 0 });

  console.log('\n[4] The released stock can be reserved again');
  const again = await callApi('POST', '/v1/reservations', { item_id: item.id, customer_id: 'customer-d', quantity: 5 });
  check(again.status === 201, `a new reservation of all 5 units gets 201 Created (got ${again.status})`);
  await checkQuantities(item.id, { total: 5, available: 0, held: 5, confirmed: 0 });

  printResult();
}

main().catch((error) => {
  console.error('\nThe test stopped because of an error:', error);
  process.exitCode = 1;
});
