-- =====================================================================
-- 002: Use a time that matches the data when reading stock numbers
--
-- Run this once in the Supabase SQL Editor, after 001.
--
-- Problem found in review (writes were not affected):
-- get_item_status compared expires_at with now(). now() is the time when the
-- TRANSACTION started. The rows the function reads come from a snapshot taken
-- when the calling STATEMENT started, which can be later. If a hold expired and
-- another request reserved the released unit between those two moments, the read
-- counted both holds. Reproduced with two database sessions on an item with 1 unit:
-- held 2, available -1.
--
-- Fix: read the clock with clock_timestamp() inside the function, before the queries.
-- A STABLE function reads the snapshot of the calling statement, and that snapshot
-- already exists when the function body starts. So this time is always at or after
-- the snapshot. Every reservation in the snapshot was checked against an earlier
-- clock, so the numbers can never show more stock in use than the item has.
-- =====================================================================

begin;

create or replace function public.get_item_status(p_item_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_item public.items;
  v_held_quantity bigint;
  v_confirmed_quantity bigint;
begin
  -- The queries below read the snapshot of the calling statement, which already exists.
  -- Read the clock now, so the time is at or after that snapshot.
  -- Do not use now() here: it is the transaction start time, which can be earlier.
  v_now := clock_timestamp();

  select * into v_item
  from public.items
  where id = p_item_id;

  if not found then
    return jsonb_build_object('result', 'ITEM_NOT_FOUND');
  end if;

  -- held      = PENDING reservations whose deadline is after v_now
  -- confirmed = CONFIRMED reservations (they stay counted forever)
  select
    coalesce(sum(quantity) filter (where status = 'PENDING' and expires_at > v_now), 0),
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

-- CREATE OR REPLACE keeps the existing permissions. They are set again here so this
-- file gives the same result on its own.
revoke execute on function public.get_item_status(uuid) from public, anon, authenticated;
grant execute on function public.get_item_status(uuid) to service_role;

-- Ask the Supabase Data API to reload its list of functions.
notify pgrst, 'reload schema';

commit;
