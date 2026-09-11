# Inventory Reservation API

- **Repository:** https://github.com/janpatrickpalacio/inventory-reservation-api
- **Deployed API:** https://inventory-reservation-api-red.vercel.app
  - Swagger UI: https://inventory-reservation-api-red.vercel.app/docs
  - OpenAPI JSON: https://inventory-reservation-api-red.vercel.app/openapi.json
- **Demo video:** https://drive.google.com/file/d/1_294QjjVelXtqjqRPn5eA3mQj8nks_qv/view?usp=sharing

A small backend for a store. You create items with a starting stock, hold stock for a customer (a reservation), then confirm or cancel the reservation. Holds that are not confirmed in time expire.

The API stays correct when requests overlap (it never oversells) and when requests are retried (it never deducts or releases stock twice).

**Stack:** Express 5 + TypeScript · Supabase (PostgreSQL) · Vercel

---

## Contents

1. [How it works](#how-it-works)
2. [Assumptions](#assumptions)
3. [API](#api)
4. [Project structure](#project-structure)
5. [Set up Supabase and run the migration](#set-up-supabase-and-run-the-migration)
6. [Environment variables](#environment-variables)
7. [Run locally](#run-locally)
8. [Tests and concurrency scenarios](#tests-and-concurrency-scenarios)
9. [Verification](#verification)
10. [Deploy to Vercel](#deploy-to-vercel)
11. [Time spent](#time-spent)
12. [Known limitations and trade-offs](#known-limitations-and-trade-offs)

---

## How it works

### Stock numbers

`items.total_quantity` is the starting stock. It never changes. The other numbers are calculated from the `reservations` table every time:

```text
held      = sum of quantity of PENDING reservations whose expires_at is in the future
confirmed = sum of quantity of CONFIRMED reservations
available = total - held - confirmed
```

There is no stored "available" counter, so a retried request cannot change it twice. Confirming moves units from `held` to `confirmed`, so `available` does not change again.

### Reservation states

```text
                 confirm (before expires_at)
              ┌──────────────────────────────► CONFIRMED   (stock used permanently)
              │
PENDING ──────┼─ cancel (before expires_at) ─► CANCELLED   (stock released)
(holds stock) │
              └─ expires_at passes ──────────► EXPIRED     (stock released)
```

CONFIRMED, CANCELLED, and EXPIRED are final. A reservation never leaves a final state.

### Correctness when requests overlap

- **One PostgreSQL function per operation.** Each endpoint calls one function with `supabase.rpc(...)`. Supabase runs a function call as one transaction, so all its steps are saved together or not at all.
- **Lock the item row first.** Every function that changes reservations starts with `SELECT ... FROM items WHERE id = ... FOR UPDATE`. Requests for the same item run one after the other. Requests for different items do not wait.
- **Count after the lock.** Stock is counted in a new query after the lock is taken, so it includes reservations committed by the request that held the lock before.
- **Read the clock after the lock.** Deadlines are checked with `clock_timestamp()` after the lock, not the transaction start time, so a request that waited cannot confirm a reservation that expired while it waited.
- **Retries check the stored status.** Confirming a CONFIRMED reservation, or cancelling a CANCELLED one, changes nothing and returns the stored reservation.
- **Consistent stock reads.** `get_item_status` reads all rows from one snapshot and takes its expiry time with `clock_timestamp()` after that snapshot exists. The first version used `now()` (the transaction start time). A test with two database sessions showed that a read could then report held 2 and available -1 for an item with 1 unit. Migration 002 fixes this. Writes were not affected.

### Expiry

A PENDING reservation only holds stock while `expires_at` is in the future. As soon as the deadline passes, the stock calculation ignores it, **even if the expire endpoint never runs**. `POST /v1/maintenance/expire-reservations` then stores the status `EXPIRED` for all overdue PENDING reservations, so the table matches. A confirm or cancel on an overdue reservation also stores `EXPIRED` and returns `409`.

---

## Assumptions

- `customer_id` is a reference to a customer in another system. There is no customers table and no login.
- The hold time is set by the server (`RESERVATION_TTL_SECONDS`, default 600 seconds = 10 minutes). Clients cannot choose it.
- `initial_quantity` is stored as `total_quantity` and cannot be changed. There are no restock or delete endpoints.
- Item names do not have to be unique.
- Confirmed stock is used permanently. It never becomes available again.
- Confirming an already confirmed reservation, or cancelling an already cancelled one, is a success (`200`, same reservation). This makes retries safe.
- Cancelling a confirmed reservation returns `409 ALREADY_CONFIRMED`. Confirming a cancelled reservation returns `409 ALREADY_CANCELLED`.
- Confirming or cancelling after the deadline returns `409 RESERVATION_EXPIRED`.
- All times come from the database clock and are returned as ISO 8601 strings in UTC.

---

## API

Interactive documentation: **`/docs`** (Swagger UI). OpenAPI JSON: **`/openapi.json`**.

| Method | Path | Success | Errors |
|---|---|---|---|
| POST | `/v1/items` | `201` item | `400` |
| GET | `/v1/items/:id` | `200` item with stock numbers | `400`, `404` |
| POST | `/v1/reservations` | `201` reservation (PENDING) | `400`, `404`, `409 INSUFFICIENT_STOCK` |
| POST | `/v1/reservations/:id/confirm` | `200` reservation (CONFIRMED) | `400`, `404`, `409 ALREADY_CANCELLED`, `409 RESERVATION_EXPIRED` |
| POST | `/v1/reservations/:id/cancel` | `200` reservation (CANCELLED) | `400`, `404`, `409 ALREADY_CONFIRMED`, `409 RESERVATION_EXPIRED` |
| POST | `/v1/maintenance/expire-reservations` | `200` `{ expired_count, checked_at }` | |

Any endpoint can also return `500 INTERNAL_ERROR`.

### Examples

```bash
# Create an item
curl -X POST http://localhost:3000/v1/items \
  -H "Content-Type: application/json" \
  -d '{"name": "White T-Shirt", "initial_quantity": 5}'
# 201 {"id":"<item-id>","name":"White T-Shirt","created_at":"...","total_quantity":5}

# Reserve 2 units
curl -X POST http://localhost:3000/v1/reservations \
  -H "Content-Type: application/json" \
  -d '{"item_id": "<item-id>", "customer_id": "alice", "quantity": 2}'
# 201 {"id":"<reservation-id>","status":"PENDING","quantity":2,"expires_at":"...", ...}

# Stock numbers
curl http://localhost:3000/v1/items/<item-id>
# 200 {"id":"<item-id>","total_quantity":5,"available_quantity":3,"held_quantity":2,"confirmed_quantity":0, ...}

# Confirm (safe to repeat)
curl -X POST http://localhost:3000/v1/reservations/<reservation-id>/confirm
```

### Error format

Every error has the same shape. `details` is only present for some errors.

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Not enough stock. Requested 3, available 1.",
    "details": { "requested_quantity": 3, "available_quantity": 1 }
  }
}
```

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing or wrong fields, unknown fields, invalid UUID, quantity not a whole number ≥ 1. `details.problems` lists each problem. |
| 400 | `INVALID_JSON` | The body is not valid JSON |
| 404 | `ITEM_NOT_FOUND`, `RESERVATION_NOT_FOUND` | Valid UUID, but no such row |
| 404 | `ROUTE_NOT_FOUND` | Unknown path |
| 409 | `INSUFFICIENT_STOCK` | Not enough available stock. Nothing is reserved. |
| 409 | `ALREADY_CONFIRMED` | Cancel on a confirmed reservation |
| 409 | `ALREADY_CANCELLED` | Confirm on a cancelled reservation |
| 409 | `RESERVATION_EXPIRED` | Confirm or cancel after the deadline |
| 413 | `PAYLOAD_TOO_LARGE` | Body larger than 10 kB |
| 500 | `INTERNAL_ERROR` | Unexpected server or database error (details are only logged on the server) |

For `409` responses on confirm and cancel, `details.reservation` contains the stored reservation.

---

## Project structure

```text
migrations/
  001_inventory_schema.sql     Tables, constraints, indexes, the 6 functions, access rules
  002_fix_stock_read_time.sql  Replaces get_item_status: expiry time read after the data snapshot
src/
  app.ts          Builds the Express app (the entry point Vercel uses)
  local.ts        Starts the app on a port for local development
  config.ts       Reads and checks environment variables
  routes.ts       HTTP layer: validate input, call the service, send the response
  validation.ts   Zod schemas for request bodies and ids
  service.ts      Business layer: turns a database result into data or an HTTP error
  database.ts     Database layer: one supabase.rpc call per operation
  errors.ts       ApiError, 404 handler, error handler (one error format)
  docs.ts         OpenAPI document and the Swagger UI page
  types.ts        Shared TypeScript types
tests/
  http.test.ts    Fast HTTP tests (no database)
scripts/
  concurrency-test.ts   Overlapping requests against a running API
  expiry-test.ts        Expiry behaviour against a running API with a short hold time
  demo.ts               Step-by-step demo for the video
```

Request path: `routes.ts` → `service.ts` → `database.ts` → PostgreSQL function.

### Database

- **`items`**: `id`, `name`, `total_quantity`, `created_at`.
- **`reservations`**: `id`, `item_id` (foreign key to `items`, `ON DELETE RESTRICT`), `customer_id`, `quantity`, `status`, `created_at`, `expires_at`, `confirmed_at`, `cancelled_at`, `expired_at`.
- **Constraints:** quantities greater than 0; names and customer ids not blank and at most 200 characters; status is one of the four values; each status has exactly its own timestamp; `confirmed_at` and `cancelled_at` are before `expires_at`; `expired_at` is at or after `expires_at`; `expires_at` is after `created_at`.
- **Indexes:** `(item_id, status, expires_at)` for stock calculations and the foreign key; `(expires_at) WHERE status = 'PENDING'` for the expire endpoint.
- **Functions:** `create_item`, `get_item_status`, `create_reservation`, `confirm_reservation`, `cancel_reservation`, `expire_reservations`.
- **Access:** Row Level Security is enabled with no policies. The public roles `anon` and `authenticated` cannot read or write the tables or call the functions. Only `service_role` (the Supabase secret key used by this API) can call the functions, and it can read, insert, and update the tables but not delete from them.

---

## Set up Supabase and run the migration

1. Create a new project at [supabase.com](https://supabase.com/dashboard):
   - **Enable Data API**: on. The API calls the database functions through it.
   - **Automatically expose new tables**: off (Supabase's recommendation). The migration gives the same permissions either way, because it first removes all automatic permissions and then grants only what the API needs.
   - **Enable automatic RLS**: not needed. The migration enables Row Level Security itself.
2. Open **SQL Editor → New query**. Paste the whole content of [`migrations/001_inventory_schema.sql`](migrations/001_inventory_schema.sql) and click **Run**. The result is "Success. No rows returned".
3. Open another new query. Paste the whole content of [`migrations/002_fix_stock_read_time.sql`](migrations/002_fix_stock_read_time.sql) and click **Run**. It replaces `get_item_status` with the version that reads the clock after its data snapshot (see [How it works](#how-it-works)).
4. Copy two values for the environment variables:
   - **Project URL**, in the form `https://<project-ref>.supabase.co`: **Connect** button, or **Project Settings → Data API**. Do not include `/rest/v1`, because supabase-js adds it. The app refuses to start if the URL contains it.
   - **Secret key** (starts with `sb_secret_`): **Project Settings → API Keys**

Each migration runs in one transaction. Run 001 once, on a project without these tables: a second run fails because the tables already exist, and it changes nothing. 002 only replaces one function, so running it again is harmless.

---

## Environment variables

| Name | Required | Default | Description |
|---|---|---|---|
| `SUPABASE_URL` | yes | | Supabase Project URL, for example `https://abcd1234.supabase.co` (without `/rest/v1`) |
| `SUPABASE_SECRET_KEY` | yes | | Supabase secret key (`sb_secret_...`). Server-side only. Never commit it or use it in a browser. |
| `RESERVATION_TTL_SECONDS` | no | `600` | How long a reservation holds stock, in seconds (1 to 86400) |
| `PORT` | no | `3000` | Local port. Vercel ignores it. |

All variables are listed in [`.env.example`](.env.example). If a required variable is missing, the app stops at startup and prints the variable name.

---

## Run locally

Requirements: Node.js 24 and npm. [`.nvmrc`](.nvmrc) contains `24`, so `nvm use` or `fnm use` selects the right version.

```bash
npm ci
cp .env.example .env      # then fill in SUPABASE_URL and SUPABASE_SECRET_KEY
npm run dev
```

Open <http://localhost:3000/docs>.

`npm run dev` restarts on file changes. `npm start` runs without watching. Both read `.env`. A variable set in your shell wins over the value in `.env`.

Type check: `npm run typecheck`.

---

## Tests and concurrency scenarios

### 1. Fast tests (no database)

```bash
npm test
```

15 tests for input validation, the error format, unknown routes, `/openapi.json`, and `/docs`. They use fake settings from `tests/test.env` and never call a database.

### 2. Concurrency test (real API and database)

Start the API (`npm run dev`) with the default hold time, then in another terminal:

```bash
npm run test:concurrency
# or against the deployed API:
npm run test:concurrency -- --base-url https://inventory-reservation-api-red.vercel.app
```

Each scenario creates its own new item and sends requests at the same time (`Promise.all`):

| # | Scenario | Expected result |
|---|---|---|
| 1 | 20 reservations of 1 unit for an item with 5 units | exactly 5 × `201`, 15 × `409 INSUFFICIENT_STOCK`, no other responses; stock 5 / 0 / 5 / 0 |
| 2 | The same confirm sent 10 times | all `200 CONFIRMED` with the same `confirmed_at`; stock 5 / 3 / 0 / 2 |
| 3 | The same cancel sent 10 times | all `200 CANCELLED` with the same `cancelled_at`; stock 5 / 5 / 0 / 0 (not 7) |
| 4 | 5 confirms and 5 cancels for one reservation | exactly one action wins; the other action gets `409`; stock matches the winner |

Stock is shown as total / available / held / confirmed. The script prints `PASS` or `FAIL` for each check, prints the item ids (so you can find the rows in Supabase), and exits with code 1 if any check fails. Network errors and `500` responses are counted as failures, never as `409`.

### 3. Expiry test (real API with a short hold time)

Start the API with a 5-second hold time:

```bash
RESERVATION_TTL_SECONDS=5 npm run dev            # bash
$env:RESERVATION_TTL_SECONDS=5; npm run dev      # PowerShell
```

Then in another terminal:

```bash
npm run test:expiry
```

It checks that:

- a fully held item refuses new reservations
- after the deadline, the stock is available again **before** the expire endpoint runs
- a late confirm gets `409 RESERVATION_EXPIRED`, stores `EXPIRED`, and deducts nothing
- the expire endpoint marks the remaining overdue reservation `EXPIRED`
- a second call to the expire endpoint is safe
- the released stock can be reserved again

### 4. Manual: a confirm that waits for the lock while the deadline passes

This shows why the deadline is checked with the clock **after** the lock. It uses three tabs in the Supabase **SQL Editor**. SQL Editor queries can run for up to 60 seconds, but API calls have an 8-second database timeout, so this check is done in SQL rather than through the API.

1. In any tab, create an item and copy its `id` from the result:

   ```sql
   select public.create_item('Lock test', 1);
   ```

2. Prepare three tabs with the item id. Do not run them yet.

   **Tab A:** create a reservation that holds stock for 20 seconds

   ```sql
   select public.create_reservation('<ITEM_ID>', 'lock-test', 1, 20);
   ```

   **Tab B:** hold the item lock for 30 seconds

   ```sql
   begin;
   select id from public.items where id = '<ITEM_ID>' for update;
   select pg_sleep(30);
   commit;
   ```

   **Tab C:** confirm the newest reservation of this item

   ```sql
   select public.confirm_reservation(
     (select id from public.reservations where item_id = '<ITEM_ID>' order by created_at desc limit 1)
   );
   ```

3. Run **A**, then **B**, then **C**, within about 10 seconds.

**Expected:** Tab C keeps running until Tab B finishes. Then it returns `"result": "RESERVATION_EXPIRED"` with `"status": "EXPIRED"`. The confirm started before the 20-second deadline, but it got the lock after the deadline, and the function checks the time after it gets the lock.

To see the normal case, run **A** and then **C** without **B**: the result is `"result": "OK"` with `"status": "CONFIRMED"`.

### 5. Demo script (used in the video)

Create a new item with 5 units in Swagger, then:

```bash
npm run demo -- --item-id <item-id>
```

It pauses before each step and prints each real request, response, and the stock numbers: reserve 2 (A), reserve 1 (B), confirm B, confirm B again, cancel A, cancel A again, try to cancel B (`409`). Final stock: 5 / 4 / 0 / 1. Add `--no-pause` to run all steps without waiting.

---

## Verification

[`VERIFICATION.md`](VERIFICATION.md) lists every check that was actually run, with its real result, and marks the checks that were not run. Summary:

| Check | Result |
|---|---|
| `npm run typecheck` | No errors |
| `npm test` | 15 of 15 tests passed |
| Migration in the Supabase SQL Editor | "Success. No rows returned" |
| `npm run test:concurrency` against the local API and Supabase | 14 of 14 checks passed (20 overlapping requests for 5 units: 5 × `201`, 15 × `409`) |
| `npm run test:expiry` with a 5-second hold time | 13 of 13 checks passed |
| Demo script, full run | Final stock 5 / 4 / 0 / 1, as expected |
| Deployed API smoke test, without a Vercel login | Passed (docs, OpenAPI, full lifecycle, errors; function region `icn1`) |
| `npm run test:concurrency` against the deployed API | 14 of 14 checks passed |
| Manual lock-wait check in the SQL Editor | Not run |
| Swagger "Try it out" in a browser on the deployed URL | Not run |
| Stock read race with two database sessions (real PostgreSQL 18.4) | Before 002: a read showed held 2 and available -1 on a 1-unit item. After 002: held 1, available 0 |
| 55 SQL checks on 001 + 002 (lifecycle, constraints, permissions) | 55 of 55 passed, with and without automatic grants |
| Migration 002 in the Supabase SQL Editor, then the tests again | Run by the project owner. Afterwards: local concurrency 14 of 14, expiry 13 of 13, deployed concurrency 14 of 14 |

---

## Deploy to Vercel

Vercel detects the Express app in `src/app.ts` (default export). [`vercel.json`](vercel.json) only sets the function region to `icn1` (Seoul), next to the Supabase database (`ap-northeast-2`, Seoul). Vercel's default region is `iad1` (Washington, D.C.). If your Supabase project is in another region, change `regions` to the closest [Vercel region](https://vercel.com/docs/regions).

The Vercel project for this repository is connected to GitHub, so every push to `main` creates a new production deployment.

### With the Vercel dashboard

1. Push the repository to GitHub.
2. In Vercel, **Add New → Project** and import the repository. The framework preset is detected as **Express**.
3. Add the environment variables `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (and `RESERVATION_TTL_SECONDS` if you want a value other than 600).
4. Click **Deploy**.

### With the Vercel CLI

```bash
npx vercel link
npx vercel env add SUPABASE_URL production
npx vercel env add SUPABASE_SECRET_KEY production
npx vercel deploy --prod
```

`.vercelignore` stops the CLI from uploading a local `.env` file. Vercel's default ignore list covers `.env.local`, but not `.env`.

### Check the deployment

- Open `https://<your-app>.vercel.app/docs` and run a request with **Try it out**.
- Run `npm run test:concurrency -- --base-url https://<your-app>.vercel.app`.

Use the production domain for reviewers. Preview deployment URLs can be protected by Vercel login.

---

## Time spent

Measured from the command history and git timestamps on 12 September 2026 (UTC+8). The work was done with AI assistance, which the assignment allows (section 3).

| Moment | Time |
|---|---|
| First setup command | 01:35 |
| Code, migration, tests, and scripts committed | 02:05 |
| Tests against Supabase passed; README committed | 02:34 |
| Deployed API passed its smoke and concurrency tests | 02:38 |
| README links pushed; automatic redeploy checked | 02:42 |

Total: about 67 minutes from the first command to a verified deployment. This includes creating the Supabase project and logging in to Vercel. It does not include writing the implementation plan before the first command, or recording the demo video.

---

## Known limitations and trade-offs

These are deliberate choices for the 4-hour scope:

- **No authentication or ownership checks.** Anyone with the URL can call every endpoint, including confirm, cancel, and the expire endpoint. The assignment does not include user accounts. A real service would take the customer from a login token and check ownership.
- **No rate limiting.**
- **Creating a reservation is not idempotent.** A retried `POST /v1/reservations` creates a second reservation. Confirm and cancel are retry-safe. An `Idempotency-Key` header would fix this.
- **No scheduler.** Expired reservations stop holding stock at their deadline without any job, but their stored status stays `PENDING` until the expire endpoint (or a confirm or cancel) runs. A real service would call the endpoint on a schedule.
- **The expire endpoint handles all overdue reservations in one transaction.** This is fine for this size. For very large numbers of rows it should work in batches.
- **Requests for the same item wait for each other.** Each one takes milliseconds, so this is fine for normal traffic. A very busy item would need a different design, for example a stored counter updated with a conditional `UPDATE`.
- **Stock is summed from reservation rows on every request.** An index keeps this fast, but an item with a very large number of reservations would need a stored counter.
- **Database time limit.** Supabase stops API database calls after 8 seconds, so a request that waits that long for a lock returns `500`.
- **The docs page loads Swagger UI from the jsDelivr CDN** (pinned version 5.32.15). If the CDN is not reachable, `/docs` does not render, but the API and `/openapi.json` still work.
- **The OpenAPI document is written by hand** and must be updated when the API changes. A test checks that all six paths are documented.
