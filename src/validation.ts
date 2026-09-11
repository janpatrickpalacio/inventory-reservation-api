import { z } from 'zod';
import { ApiError } from './errors';

// PostgreSQL "integer" columns store whole numbers up to 2,147,483,647.
const MAX_QUANTITY = 2_147_483_647;

// strictObject rejects unknown fields, so a typo like "initialQuantity" gets a clear 400 error.
// z.int() rejects decimals (1.5) and strings ("5"): no silent conversion.
export const createItemSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  initial_quantity: z.int().min(1).max(MAX_QUANTITY),
});

export const createReservationSchema = z.strictObject({
  item_id: z.uuid(),
  customer_id: z.string().trim().min(1).max(200),
  quantity: z.int().min(1).max(MAX_QUANTITY),
});

// For URLs like /v1/items/:id and /v1/reservations/:id/confirm
export const idParamsSchema = z.object({
  id: z.uuid(),
});

// Checks input against a schema and returns the typed, cleaned value.
// If the input is invalid, it throws a 400 error that lists every problem.
export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
    }));
    throw new ApiError(400, 'VALIDATION_ERROR', 'The request is not valid.', { problems });
  }

  return result.data;
}
