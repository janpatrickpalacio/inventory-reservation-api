import { config } from './config';
import * as database from './database';
import { ApiError } from './errors';
import type { ExpireReservationsSummary, Item, ItemStatus, Reservation } from './types';

// Business layer.
// It calls the database layer and decides what each result means for the API:
// a value to return, or an ApiError with the right HTTP status.
// The stock rules themselves run inside the SQL functions, where they are protected by locks.

export async function createItem(name: string, initialQuantity: number): Promise<Item> {
  const outcome = await database.createItem(name, initialQuantity);
  return outcome.item;
}

export async function getItemStatus(itemId: string): Promise<ItemStatus> {
  const outcome = await database.getItemStatus(itemId);

  if (outcome.result === 'ITEM_NOT_FOUND') {
    throw new ApiError(404, 'ITEM_NOT_FOUND', `Item ${itemId} does not exist.`);
  }

  return outcome.item;
}

export async function createReservation(input: {
  item_id: string;
  customer_id: string;
  quantity: number;
}): Promise<Reservation> {
  // The hold time comes from server configuration. Clients cannot choose it.
  const outcome = await database.createReservation(
    input.item_id,
    input.customer_id,
    input.quantity,
    config.reservationTtlSeconds,
  );

  if (outcome.result === 'ITEM_NOT_FOUND') {
    throw new ApiError(404, 'ITEM_NOT_FOUND', `Item ${input.item_id} does not exist.`);
  }

  if (outcome.result === 'INSUFFICIENT_STOCK') {
    throw new ApiError(
      409,
      'INSUFFICIENT_STOCK',
      `Not enough stock. Requested ${input.quantity}, available ${outcome.available_quantity}.`,
      { requested_quantity: input.quantity, available_quantity: outcome.available_quantity },
    );
  }

  return outcome.reservation;
}

export async function confirmReservation(reservationId: string): Promise<Reservation> {
  const outcome = await database.confirmReservation(reservationId);

  if (outcome.result === 'RESERVATION_NOT_FOUND') {
    throw new ApiError(404, 'RESERVATION_NOT_FOUND', `Reservation ${reservationId} does not exist.`);
  }

  if (outcome.result === 'ALREADY_CANCELLED') {
    throw new ApiError(409, 'ALREADY_CANCELLED', 'This reservation was cancelled, so it cannot be confirmed.', {
      reservation: outcome.reservation,
    });
  }

  if (outcome.result === 'RESERVATION_EXPIRED') {
    throw new ApiError(409, 'RESERVATION_EXPIRED', 'This reservation has expired, so it cannot be confirmed.', {
      reservation: outcome.reservation,
    });
  }

  // 'OK' means it was confirmed now. 'ALREADY_CONFIRMED' means an earlier request confirmed it
  // (for example, a retry). Both are a success, and both return the same stored reservation.
  return outcome.reservation;
}

export async function cancelReservation(reservationId: string): Promise<Reservation> {
  const outcome = await database.cancelReservation(reservationId);

  if (outcome.result === 'RESERVATION_NOT_FOUND') {
    throw new ApiError(404, 'RESERVATION_NOT_FOUND', `Reservation ${reservationId} does not exist.`);
  }

  if (outcome.result === 'ALREADY_CONFIRMED') {
    throw new ApiError(409, 'ALREADY_CONFIRMED', 'This reservation is confirmed, so it cannot be cancelled.', {
      reservation: outcome.reservation,
    });
  }

  if (outcome.result === 'RESERVATION_EXPIRED') {
    throw new ApiError(409, 'RESERVATION_EXPIRED', 'This reservation has expired, so there is nothing to cancel.', {
      reservation: outcome.reservation,
    });
  }

  // 'OK' means it was cancelled now. 'ALREADY_CANCELLED' means an earlier request cancelled it.
  // Both are a success, and stock was released only once.
  return outcome.reservation;
}

export async function expireReservations(): Promise<ExpireReservationsSummary> {
  const outcome = await database.expireReservations();
  return { expired_count: outcome.expired_count, checked_at: outcome.checked_at };
}
