// Shapes of the data the API returns. Field names match the database columns.
// Timestamps are ISO 8601 strings, for example "2026-09-12T08:30:00.123456+00:00".

export type ReservationStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';

export interface Item {
  id: string;
  name: string;
  total_quantity: number;
  created_at: string;
}

export interface ItemStatus extends Item {
  available_quantity: number;
  held_quantity: number;
  confirmed_quantity: number;
}

export interface Reservation {
  id: string;
  item_id: string;
  customer_id: string;
  quantity: number;
  status: ReservationStatus;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
  cancelled_at: string | null;
  expired_at: string | null;
}

export interface ExpireReservationsSummary {
  expired_count: number;
  checked_at: string;
}
