-- =====================================================================
-- Inventory Reservation API: complete database schema
--
-- Run this file once, in the Supabase SQL Editor, on a new project.
-- It runs inside one transaction: either everything is created, or nothing is.
-- It is not meant to be run twice (the second run fails because the tables exist).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- An item is a product with a fixed starting stock (total_quantity).
-- "Available" stock is NOT stored. It is calculated from the reservations table,
-- so there is no counter that a retried request could change twice.
create table public.items (
  id             uuid        primary key default gen_random_uuid(),
  name           text        not null,
  total_quantity integer     not null,
  created_at     timestamptz not null default now(),

  constraint items_name_not_blank          check (btrim(name) <> ''),
  constraint items_name_max_length         check (char_length(name) <= 200),
  constraint items_total_quantity_positive check (total_quantity > 0)
);

-- A reservation holds some quantity of one item for one customer.
--   PENDING   = holds stock until expires_at
--   CONFIRMED = stock is sold (permanently used)
--   CANCELLED = stock is released
--   EXPIRED   = the deadline passed, stock is released
create table public.reservations (
  id           uuid        primary key default gen_random_uuid(),
  item_id      uuid        not null references public.items (id) on delete restrict,
  customer_id  text        not null,
  quantity     integer     not null,
  status       text        not null default 'PENDING',
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  expired_at   timestamptz,

  constraint reservations_customer_id_not_blank  check (btrim(customer_id) <> ''),
  constraint reservations_customer_id_max_length check (char_length(customer_id) <= 200),
  constraint reservations_quantity_positive      check (quantity > 0),
  constraint reservations_status_valid           check (status in ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')),
  constraint reservations_expires_after_created  check (expires_at > created_at),

  -- Each status has exactly the timestamp that belongs to it, and no other.
  constraint reservations_status_matches_timestamps check (
       (status = 'PENDING'   and confirmed_at is null     and cancelled_at is null     and expired_at is null)
    or (status = 'CONFIRMED' and confirmed_at is not null and cancelled_at is null     and expired_at is null)
    or (status = 'CANCELLED' and confirmed_at is null     and cancelled_at is not null and expired_at is null)
    or (status = 'EXPIRED'   and confirmed_at is null     and cancelled_at is null     and expired_at is not null)
  ),

  -- Deadline rules. The database rejects a row that breaks them, even if the code has a bug:
  -- confirm and cancel only happen before the deadline; expiry only happens at or after it.
  constraint reservations_confirmed_before_deadline check (confirmed_at is null or confirmed_at < expires_at),
  constraint reservations_cancelled_before_deadline check (cancelled_at is null or cancelled_at < expires_at),
  constraint reservations_expired_after_deadline    check (expired_at is null or expired_at >= expires_at)
);

-- ---------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------

-- Used when we calculate stock for one item: "reservations of this item, by status and deadline".
-- Its first column is item_id, so it also serves the foreign key.
create index reservations_item_id_status_expires_at_idx
  on public.reservations (item_id, status, expires_at);

-- Used by the expire endpoint: "PENDING reservations whose deadline has passed".
-- It only contains PENDING rows, so it stays small.
create index reservations_pending_expires_at_idx
  on public.reservations (expires_at)
  where status = 'PENDING';

-- ---------------------------------------------------------------------
-- 3. Functions (one per API operation)
--
-- The API calls these functions through Supabase (supabase.rpc).
-- Each call runs in its own transaction: all steps inside succeed together or fail together.
--
-- The one locking rule: every function that changes reservations first locks the
-- item row (SELECT ... FOR UPDATE). Two requests for the same item therefore run
-- one after the other, never at the same time. Requests for different items do not wait.
--
-- Every function returns JSON with a "result" code, for example
-- {"result": "INSUFFICIENT_STOCK", ...}. The API turns that code into an HTTP status.
-- Expected problems are returned, not raised as SQL errors, so that changes made
-- before the problem was found (like marking a reservation EXPIRED) are still saved.
--
-- "set search_path = ''" makes each function use only the tables we name with
-- "public.", so an object with the same name in another schema cannot be used by mistake.
-- ---------------------------------------------------------------------

-- POST /v1/items
create function public.create_item(p_name text, p_initial_quantity integer)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item public.items;
begin
  insert into public.items (name, total_quantity)
  values (p_name, p_initial_quantity)
  returning * into v_item;

  return jsonb_build_object('result', 'OK', 'item', to_jsonb(v_item));
end;
$$;

-- GET /v1/items/:id
-- "stable" means this function only reads. All queries inside it see the same
-- snapshot of the data, so the numbers always add up to total_quantity.
create function public.get_item_status(p_item_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_item public.items;
  v_held_quantity bigint;
  v_confirmed_quantity bigint;
begin
  select * into v_item
  from public.items
  where id = p_item_id;

  if not found then
    return jsonb_build_object('result', 'ITEM_NOT_FOUND');
  end if;

  -- held      = PENDING reservations whose deadline is still in the future
  -- confirmed = CONFIRMED reservations (they stay counted forever)
  -- Same rule as in create_reservation below.
  select
    coalesce(sum(quantity) filter (where status = 'PENDING' and expires_at > now()), 0),
    coalesce(sum(quantity) filter (where status = 'CONFIRMED'), 0)
  into v_held_quantity, v_confirmed_quantity
  from public.reservations
  where item_id = p_item_id;

  return jsonb_build_object(
    'result', 'OK',
    'item', jsonb_build_object(
      'id', v_item.id,
      'name', v_item.name,
      'total_quantity', v_item.total_quantity,
      'available_quantity', v_item.total_quantity - v_held_quantity - v_confirmed_quantity,
      'held_quantity', v_held_quantity,
      'confirmed_quantity', v_confirmed_quantity,
      'created_at', v_item.created_at
    )
  );
end;
$$;

-- POST /v1/reservations
create function public.create_reservation(
  p_item_id uuid,
  p_customer_id text,
  p_quantity integer,
  p_ttl_seconds integer
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_total_quantity integer;
  v_now timestamptz;
  v_used_quantity bigint;
  v_available_quantity bigint;
  v_reservation public.reservations;
begin
  -- Step 1: lock the item row.
  -- If another request holds this lock, we wait here until that request commits.
  select total_quantity into v_total_quantity
  from public.items
  where id = p_item_id
  for update;

  if not found then
    return jsonb_build_object('result', 'ITEM_NOT_FOUND');
  end if;

  -- Step 2: read the clock AFTER we have the lock, because we may have waited.
  v_now := clock_timestamp();

  -- Step 3: count the stock that is already used. This is a new query, so it sees
  -- every reservation that the request we waited for has committed.
  select coalesce(sum(quantity), 0) into v_used_quantity
  from public.reservations
  where item_id = p_item_id
    and (status = 'CONFIRMED' or (status = 'PENDING' and expires_at > v_now));

  v_available_quantity := v_total_quantity - v_used_quantity;

  -- Step 4: not enough stock? Stop without writing anything.
  if p_quantity > v_available_quantity then
    return jsonb_build_object(
      'result', 'INSUFFICIENT_STOCK',
      'available_quantity', v_available_quantity
    );
  end if;

  -- Step 5: create the hold. The lock is released when the transaction commits.
  insert into public.reservations (item_id, customer_id, quantity, status, created_at, expires_at)
  values (p_item_id, p_customer_id, p_quantity, 'PENDING', v_now, v_now + p_ttl_seconds * interval '1 second')
  returning * into v_reservation;

  return jsonb_build_object('result', 'OK', 'reservation', to_jsonb(v_reservation));
end;
$$;

-- POST /v1/reservations/:id/confirm
create function public.confirm_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item_id uuid;
  v_reservation public.reservations;
  v_now timestamptz;
begin
  -- Step 1: find the item of this reservation. item_id never changes, so no lock is needed yet.
  select item_id into v_item_id
  from public.reservations
  where id = p_reservation_id;

  if not found then
    return jsonb_build_object('result', 'RESERVATION_NOT_FOUND');
  end if;

  -- Step 2: lock the item row (the same lock that create_reservation uses).
  perform 1 from public.items where id = v_item_id for update;

  -- Step 3: read the reservation again now that we hold the lock,
  -- and read the clock after the lock, because we may have waited.
  select * into v_reservation
  from public.reservations
  where id = p_reservation_id;

  v_now := clock_timestamp();

  -- Step 4: is the reservation already finished? Then change nothing.
  if v_reservation.status = 'CONFIRMED' then
    -- A retry of a confirm that already worked. Return the same reservation. Nothing is deducted again.
    return jsonb_build_object('result', 'ALREADY_CONFIRMED', 'reservation', to_jsonb(v_reservation));
  elsif v_reservation.status = 'CANCELLED' then
    return jsonb_build_object('result', 'ALREADY_CANCELLED', 'reservation', to_jsonb(v_reservation));
  elsif v_reservation.status = 'EXPIRED' then
    return jsonb_build_object('result', 'RESERVATION_EXPIRED', 'reservation', to_jsonb(v_reservation));
  end if;

  -- Step 5: the status is PENDING. If the deadline has passed, save EXPIRED and refuse.
  -- We use RETURN, not RAISE EXCEPTION, so the EXPIRED status is committed.
  if v_reservation.expires_at <= v_now then
    update public.reservations
    set status = 'EXPIRED', expired_at = v_now
    where id = p_reservation_id
    returning * into v_reservation;

    return jsonb_build_object('result', 'RESERVATION_EXPIRED', 'reservation', to_jsonb(v_reservation));
  end if;

  -- Step 6: the hold is still valid. Confirm it.
  -- The quantity was already counted as used while PENDING, so the stock numbers do not
  -- change twice: the quantity moves from "held" to "confirmed".
  update public.reservations
  set status = 'CONFIRMED', confirmed_at = v_now
  where id = p_reservation_id
  returning * into v_reservation;

  return jsonb_build_object('result', 'OK', 'reservation', to_jsonb(v_reservation));
end;
$$;

-- POST /v1/reservations/:id/cancel
-- Same steps as confirm_reservation, with the opposite final action.
create function public.cancel_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item_id uuid;
  v_reservation public.reservations;
  v_now timestamptz;
begin
  -- Step 1: find the item of this reservation.
  select item_id into v_item_id
  from public.reservations
  where id = p_reservation_id;

  if not found then
    return jsonb_build_object('result', 'RESERVATION_NOT_FOUND');
  end if;

  -- Step 2: lock the item row.
  perform 1 from public.items where id = v_item_id for update;

  -- Step 3: read the reservation again, and the clock, after the lock.
  select * into v_reservation
  from public.reservations
  where id = p_reservation_id;

  v_now := clock_timestamp();

  -- Step 4: is the reservation already finished? Then change nothing.
  if v_reservation.status = 'CANCELLED' then
    -- A retry of a cancel that already worked. Nothing is released again.
    return jsonb_build_object('result', 'ALREADY_CANCELLED', 'reservation', to_jsonb(v_reservation));
  elsif v_reservation.status = 'CONFIRMED' then
    -- Sold stock never comes back through cancel.
    return jsonb_build_object('result', 'ALREADY_CONFIRMED', 'reservation', to_jsonb(v_reservation));
  elsif v_reservation.status = 'EXPIRED' then
    return jsonb_build_object('result', 'RESERVATION_EXPIRED', 'reservation', to_jsonb(v_reservation));
  end if;

  -- Step 5: PENDING but past the deadline: save EXPIRED and refuse (RETURN keeps the change).
  if v_reservation.expires_at <= v_now then
    update public.reservations
    set status = 'EXPIRED', expired_at = v_now
    where id = p_reservation_id
    returning * into v_reservation;

    return jsonb_build_object('result', 'RESERVATION_EXPIRED', 'reservation', to_jsonb(v_reservation));
  end if;

  -- Step 6: the hold is still valid. Cancel it. The quantity stops counting as "held".
  update public.reservations
  set status = 'CANCELLED', cancelled_at = v_now
  where id = p_reservation_id
  returning * into v_reservation;

  return jsonb_build_object('result', 'OK', 'reservation', to_jsonb(v_reservation));
end;
$$;

-- POST /v1/maintenance/expire-reservations
-- Marks every PENDING reservation whose deadline has passed as EXPIRED.
-- Stock calculations already ignore those reservations after their deadline;
-- this function makes the stored status match.
create function public.expire_reservations()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_item_id uuid;
  v_changed_rows integer;
  v_expired_count integer := 0;
begin
  -- Visit each item that has overdue PENDING reservations.
  -- Items are always visited in the same order (by id). If two runs of this function
  -- overlap, they lock items in the same order, so they cannot block each other forever (deadlock).
  for v_item_id in
    select distinct item_id
    from public.reservations
    where status = 'PENDING' and expires_at <= v_now
    order by item_id
  loop
    -- The same rule as every other write: lock the item first.
    perform 1 from public.items where id = v_item_id for update;

    update public.reservations
    set status = 'EXPIRED', expired_at = v_now
    where item_id = v_item_id
      and status = 'PENDING'
      and expires_at <= v_now;

    get diagnostics v_changed_rows = row_count;
    v_expired_count := v_expired_count + v_changed_rows;
  end loop;

  return jsonb_build_object('result', 'OK', 'expired_count', v_expired_count, 'checked_at', v_now);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Access rules
--
-- The API server uses the Supabase secret key. That key uses the database role "service_role".
-- The public roles "anon" and "authenticated" (used by Supabase publishable keys)
-- must not read or change this data, and must not call these functions.
-- ---------------------------------------------------------------------

-- Row Level Security with no policies: anon and authenticated see no rows.
-- service_role skips Row Level Security.
alter table public.items enable row level security;
alter table public.reservations enable row level security;

-- Table permissions. New Supabase projects no longer grant these automatically.
-- service_role may read, insert, and update (the functions need this). Nobody may delete through the API.
-- UPDATE on items is needed because SELECT ... FOR UPDATE requires it.
grant usage on schema public to service_role;
revoke all on table public.items, public.reservations from anon, authenticated;
grant select, insert, update on table public.items, public.reservations to service_role;

-- Function permissions. PostgreSQL lets everyone (PUBLIC) run a new function by default.
revoke execute on function
  public.create_item(text, integer),
  public.get_item_status(uuid),
  public.create_reservation(uuid, text, integer, integer),
  public.confirm_reservation(uuid),
  public.cancel_reservation(uuid),
  public.expire_reservations()
from public, anon, authenticated;

grant execute on function
  public.create_item(text, integer),
  public.get_item_status(uuid),
  public.create_reservation(uuid, text, integer, integer),
  public.confirm_reservation(uuid),
  public.cancel_reservation(uuid),
  public.expire_reservations()
to service_role;

-- Ask the Supabase Data API to reload its list of functions, so the API can call them right away.
notify pgrst, 'reload schema';

commit;
