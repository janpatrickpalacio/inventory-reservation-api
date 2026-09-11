# Verification

This file records checks that were actually run, and their real results.

Status values: **PASS** (ran and passed) · **FAIL** (ran and failed) · **NOT RUN** (not executed yet).

## Environment

| | |
|---|---|
| Date | 2026-09-12 |
| OS | Windows 11 Pro |
| Node.js / npm | 24.20.0 / 11.19.0 |
| TypeScript / tsx | 5.9.3 / 4.23.13 |
| Express / Zod / supabase-js | 5.2.1 / 4.6.2 / 2.116.0 |

## Results

| # | Check | How | Status | Result |
|---|---|---|---|---|
| 1 | Type check | `npm run typecheck` | PASS | No errors |
| 2 | HTTP tests without a database | `npm test` | PASS | 15 of 15 tests passed |
| 3 | App refuses to start without required variables | `npx tsx src/local.ts` with no environment variables | PASS | Stopped with `Missing or invalid environment variables: SUPABASE_URL (Invalid input: expected string, received undefined); SUPABASE_SECRET_KEY (Invalid input: expected string, received undefined)`. Names and rules only, no values |
| 3b | App refuses a `SUPABASE_URL` that contains `/rest/v1` | `npx tsx --env-file=<scratch file> src/local.ts` with `SUPABASE_URL=https://abcd1234.supabase.co/rest/v1/` | PASS | Stopped with `SUPABASE_URL (use the project URL without /rest/v1, for example https://abcd1234.supabase.co)` |
| 4 | Concurrency script treats a network error as a failure | `npm run test:concurrency -- --base-url http://127.0.0.1:9` | PASS | Exit code 1, `Could not create item: 0 {"network_error":"TypeError: fetch failed"}` |
| 5 | A shell variable overrides the value in `.env` | tsx with `--env-file-if-exists`, file value 600, shell value 5 | PASS | Printed 600 without the shell variable, 5 with it |
| 6 | Migration and all six SQL functions in PGlite (PostgreSQL 18.3 in WebAssembly) | Throwaway script, not in this repository. Run twice: (a) no automatic grants, like "Automatically expose new tables" off; (b) Supabase's automatic grants simulated with `alter default privileges in schema public grant all on tables, functions, sequences to anon, authenticated, service_role` | PASS | 55 of 55 checks in both runs: create/reserve/confirm/cancel lifecycle, repeated confirm and cancel, conflicts, not-found results, expiry before maintenance, late confirm stores EXPIRED, maintenance counts and repeat call, confirmed stock stays counted after its old deadline, 9 constraint and foreign-key violations rejected, RLS enabled, `service_role` can run the functions, `anon` gets `permission denied`. Final permissions were identical in both runs: only `service_role` can execute the six functions; `anon` and `authenticated` have no table privileges; `service_role` has exactly `select`, `insert`, `update` (no `delete`, `truncate`, `references`, `trigger`) |
| 7 | Migration runs in the Supabase SQL Editor | New Supabase project (Seoul, `ap-northeast-2`, "Automatically expose new tables" off). Whole file pasted into SQL Editor and run | PASS | Run by the project owner. Result: "Success. No rows returned". First API call afterwards: `GET /v1/items/00000000-0000-4000-8000-000000000000` returned `404 ITEM_NOT_FOUND`, so the API reached the migrated function |
| 8 | Concurrency test against the local API and Supabase | `npm run test:concurrency` (API on localhost:3000, hold time 600 s) | PASS | 14 of 14 checks. [1] 20 overlapping reservations of 1 unit, item with 5 units: 5 × `201`, 15 × `409 INSUFFICIENT_STOCK`, 0 other; stock 5 / 0 / 5 / 0 (item `3ba1ad56-86e8-4595-84b2-d66b1ffa5adb`). [2] Same confirm 10 times: 10 × `200 CONFIRMED`, 1 distinct `confirmed_at`; stock 5 / 3 / 0 / 2. [3] Same cancel 10 times: 10 × `200 CANCELLED`, 1 distinct `cancelled_at`; stock 5 / 5 / 0 / 0. [4] 5 confirms and 5 cancels: confirm won, 5 × `200`, 5 × `409 ALREADY_CONFIRMED`; stock 5 / 3 / 0 / 2 |
| 9 | Expiry test against the local API and Supabase | `npm run test:expiry -- --base-url http://localhost:3001` (second API started with `RESERVATION_TTL_SECONDS=5` and `PORT=3001` set in the shell) | PASS | 13 of 13 checks (item `f1ce7938-ebf6-4c97-8625-961b8b0f0645`). Before the deadline: stock 5 / 0 / 5 / 0, and a new reservation of 1 got `409 INSUFFICIENT_STOCK`. After waiting 7 s, before the expire endpoint: stock 5 / 5 / 0 / 0; confirming A got `409 RESERVATION_EXPIRED` and A was stored as EXPIRED; stock unchanged. Expire endpoint: first call `200` with `expired_count` 1; cancelling B got `409 RESERVATION_EXPIRED` with `expired_at` equal to `checked_at`; second call `200` with `expired_count` 0. A new reservation of all 5 units got `201`; stock 5 / 0 / 5 / 0 |
| 9b | Demo script, full run without pauses | Created item `57ba11e6-7ed4-4f30-bf69-98861c79aa1c` (5 units) with `POST /v1/items`, then `npm run demo -- --item-id <id> --no-pause` (API on localhost:3000, hold time 600 s) | PASS | Exit code 0. Reserve A (2): `201`, stock 5 / 3 / 2 / 0. Reserve B (1): `201`, 5 / 2 / 3 / 0. Confirm B: `200`, 5 / 2 / 2 / 1. Confirm B again: `200`, same `confirmed_at`, 5 / 2 / 2 / 1. Cancel A: `200`, 5 / 4 / 0 / 1. Cancel A again: `200`, same `cancelled_at`, 5 / 4 / 0 / 1. Cancel B: `409 ALREADY_CONFIRMED`, 5 / 4 / 0 / 1 |
| 10 | Manual lock-wait expiry check | README, "Manual: a confirm that waits for the lock" | NOT RUN | |
| 11 | Deployed API: `/docs`, `/openapi.json`, create, reserve, confirm, cancel | Browser and HTTP requests to the Vercel URL | NOT RUN | |
| 12 | Concurrency test against the deployed API | `npm run test:concurrency -- --base-url <vercel-url>` | NOT RUN | |

## Notes

- PGlite has a single database connection, so check 6 cannot test lock waiting or overlapping requests. Checks 8, 10, and 12 cover that against real Supabase.
- Setup problem found on the first real call: `GET /v1/items/<unknown id>` returned `500` instead of `404`. The server log showed `Database function get_item_status failed: Invalid path specified in request URL`. Cause: `SUPABASE_URL` had been copied with `/rest/v1/` at the end, and supabase-js adds `/rest/v1` again. Fix: check 3b (the app now refuses such a URL at startup) and clearer setup instructions in the README and `.env.example`.
