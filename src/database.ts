import { createClient } from '@supabase/supabase-js';
import { config } from './config';
import type { ExpireReservationsSummary, Item, ItemStatus, Reservation } from './types';

// Database access layer.
// Every operation is ONE call to a PostgreSQL function (see migrations/001_inventory_schema.sql).
// One function call runs as one transaction, so its steps cannot be split by other requests.

// The secret key gives full database access, so this client must only run on the server.
const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// What each SQL function can return. The "result" field tells us what happened.
export type CreateItemResult = { result: 'OK'; item: Item };

export type GetItemStatusResult = { result: 'OK'; item: ItemStatus } | { result: 'ITEM_NOT_FOUND' };

export type CreateReservationResult =
  | { result: 'OK'; reservation: Reservation }
  | { result: 'ITEM_NOT_FOUND' }
  | { result: 'INSUFFICIENT_STOCK'; available_quantity: number };

// Used by both confirm and cancel.
export type ReservationActionResult =
  | {
      result: 'OK' | 'ALREADY_CONFIRMED' | 'ALREADY_CANCELLED' | 'RESERVATION_EXPIRED';
      reservation: Reservation;
    }
  | { result: 'RESERVATION_NOT_FOUND' };

export type ExpireReservationsResult = { result: 'OK' } & ExpireReservationsSummary;

async function callDatabaseFunction<T>(functionName: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(functionName, args);

  if (error) {
    // An unexpected problem (network, permissions, SQL error). The error handler turns it into a 500.
    throw new Error(`Database function ${functionName} failed: ${error.message}`);
  }

  // The SQL functions live in this repository, so we know the JSON shape they return.
  return data as T;
}

export function createItem(name: string, initialQuantity: number) {
  return callDatabaseFunction<CreateItemResult>('create_item', {
    p_name: name,
    p_initial_quantity: initialQuantity,
  });
}

export function getItemStatus(itemId: string) {
  return callDatabaseFunction<GetItemStatusResult>('get_item_status', {
    p_item_id: itemId,
  });
}

export function createReservation(itemId: string, customerId: string, quantity: number, ttlSeconds: number) {
  return callDatabaseFunction<CreateReservationResult>('create_reservation', {
    p_item_id: itemId,
    p_customer_id: customerId,
    p_quantity: quantity,
    p_ttl_seconds: ttlSeconds,
  });
}

export function confirmReservation(reservationId: string) {
  return callDatabaseFunction<ReservationActionResult>('confirm_reservation', {
    p_reservation_id: reservationId,
  });
}

export function cancelReservation(reservationId: string) {
  return callDatabaseFunction<ReservationActionResult>('cancel_reservation', {
    p_reservation_id: reservationId,
  });
}

export function expireReservations() {
  return callDatabaseFunction<ExpireReservationsResult>('expire_reservations', {});
}
