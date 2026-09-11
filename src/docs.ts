// API documentation.
// openApiDocument is served at /openapi.json. swaggerUiHtml is served at /docs.
// Keep this file in sync with routes.ts, validation.ts, and service.ts.

const SWAGGER_UI_VERSION = '5.32.15';

function jsonContent(schemaName: string) {
  return { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } };
}

function errorExample(code: string, message: string, details?: Record<string, unknown>) {
  return { value: { error: details ? { code, message, details } : { code, message } } };
}

function errorResponse(description: string, examples: Record<string, { value: unknown }>) {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, examples } },
  };
}

const exampleReservation = {
  id: '6c1f0a52-3d5e-4b8a-9f3b-2a1d4c7e8f90',
  item_id: '0b7d6a3e-1c2f-4e5a-8b9c-0d1e2f3a4b5c',
  customer_id: 'customer-alice',
  quantity: 2,
  status: 'EXPIRED',
  created_at: '2026-09-12T08:00:00.000000+00:00',
  expires_at: '2026-09-12T08:10:00.000000+00:00',
  confirmed_at: null,
  cancelled_at: null,
  expired_at: '2026-09-12T08:10:03.120000+00:00',
};

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Inventory Reservation API',
    version: '1.0.0',
    description: [
      'Hold stock for a customer with a reservation, then confirm or cancel it.',
      '',
      '**Stock numbers** for an item:',
      '- `held_quantity` = sum of PENDING reservations whose `expires_at` is in the future',
      '- `confirmed_quantity` = sum of CONFIRMED reservations',
      '- `available_quantity` = `total_quantity` - `held_quantity` - `confirmed_quantity`',
      '',
      '**Expiry.** A PENDING reservation stops holding stock as soon as its `expires_at` passes,',
      'even before the expire endpoint runs. The expire endpoint then stores the status EXPIRED.',
      '',
      '**Errors** always use this shape: `{ "error": { "code": "...", "message": "...", "details": { } } }`.',
      '`details` is only present for some errors.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'The server that serves this page' }],
  tags: [
    { name: 'Items', description: 'Products and their stock numbers' },
    { name: 'Reservations', description: 'Temporary holds on stock' },
    { name: 'Maintenance', description: 'Housekeeping' },
  ],
  paths: {
    '/v1/items': {
      post: {
        tags: ['Items'],
        summary: 'Create an item',
        description: '`initial_quantity` is stored as `total_quantity`: the fixed starting stock of the item.',
        requestBody: { required: true, content: jsonContent('CreateItemRequest') },
        responses: {
          '201': { description: 'The item was created.', content: jsonContent('Item') },
          '400': { $ref: '#/components/responses/BadRequest' },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/v1/items/{id}': {
      get: {
        tags: ['Items'],
        summary: 'Get the stock numbers of an item',
        description:
          'All numbers come from one database read, so `available + held + confirmed` always equals `total`.',
        parameters: [{ $ref: '#/components/parameters/ItemId' }],
        responses: {
          '200': { description: 'Current stock numbers.', content: jsonContent('ItemStatus') },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': errorResponse('The item does not exist.', {
            ITEM_NOT_FOUND: errorExample('ITEM_NOT_FOUND', 'Item 0b7d6a3e-1c2f-4e5a-8b9c-0d1e2f3a4b5c does not exist.'),
          }),
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/v1/reservations': {
      post: {
        tags: ['Reservations'],
        summary: 'Reserve (hold) stock for a customer',
        description: [
          'Creates a PENDING reservation if enough stock is available.',
          'The reservation holds the stock until `expires_at` (set by the server, default 10 minutes).',
          '',
          'Overlapping requests for the same item are handled one at a time in the database,',
          'so stock can never be reserved twice.',
        ].join('\n'),
        requestBody: { required: true, content: jsonContent('CreateReservationRequest') },
        responses: {
          '201': { description: 'The reservation was created with status PENDING.', content: jsonContent('Reservation') },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': errorResponse('The item does not exist.', {
            ITEM_NOT_FOUND: errorExample('ITEM_NOT_FOUND', 'Item 0b7d6a3e-1c2f-4e5a-8b9c-0d1e2f3a4b5c does not exist.'),
          }),
          '409': errorResponse('Not enough stock is available. Nothing was reserved.', {
            INSUFFICIENT_STOCK: errorExample('INSUFFICIENT_STOCK', 'Not enough stock. Requested 3, available 1.', {
              requested_quantity: 3,
              available_quantity: 1,
            }),
          }),
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/v1/reservations/{id}/confirm': {
      post: {
        tags: ['Reservations'],
        summary: 'Confirm a reservation',
        description: [
          'Confirms a PENDING reservation before its `expires_at`. The quantity moves from held to confirmed',
          'and stays used permanently. No request body is needed.',
          '',
          '**Retry-safe:** confirming a reservation that is already CONFIRMED returns 200 with the same stored',
          'reservation. Nothing is deducted a second time.',
          '',
          '**After the deadline:** the reservation is stored as EXPIRED and the response is 409 RESERVATION_EXPIRED.',
          'Nothing is deducted.',
        ].join('\n'),
        parameters: [{ $ref: '#/components/parameters/ReservationId' }],
        responses: {
          '200': {
            description: 'The reservation is CONFIRMED (now, or by an earlier request).',
            content: jsonContent('Reservation'),
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { $ref: '#/components/responses/ReservationNotFound' },
          '409': errorResponse('The reservation cannot be confirmed. The error details include the stored reservation.', {
            ALREADY_CANCELLED: errorExample(
              'ALREADY_CANCELLED',
              'This reservation was cancelled, so it cannot be confirmed.',
              { reservation: { ...exampleReservation, status: 'CANCELLED', cancelled_at: '2026-09-12T08:05:00.000000+00:00', expired_at: null } },
            ),
            RESERVATION_EXPIRED: errorExample(
              'RESERVATION_EXPIRED',
              'This reservation has expired, so it cannot be confirmed.',
              { reservation: exampleReservation },
            ),
          }),
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/v1/reservations/{id}/cancel': {
      post: {
        tags: ['Reservations'],
        summary: 'Cancel a reservation',
        description: [
          'Cancels a PENDING reservation before its `expires_at`. Its quantity becomes available again.',
          'No request body is needed.',
          '',
          '**Retry-safe:** cancelling a reservation that is already CANCELLED returns 200 with the same stored',
          'reservation. Nothing is released a second time.',
          '',
          '**Confirmed reservations** cannot be cancelled (409 ALREADY_CONFIRMED), so sold stock never comes back.',
          '',
          '**After the deadline:** the reservation is stored as EXPIRED and the response is 409 RESERVATION_EXPIRED.',
          'Its stock was already released by the deadline.',
        ].join('\n'),
        parameters: [{ $ref: '#/components/parameters/ReservationId' }],
        responses: {
          '200': {
            description: 'The reservation is CANCELLED (now, or by an earlier request).',
            content: jsonContent('Reservation'),
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { $ref: '#/components/responses/ReservationNotFound' },
          '409': errorResponse('The reservation cannot be cancelled. The error details include the stored reservation.', {
            ALREADY_CONFIRMED: errorExample(
              'ALREADY_CONFIRMED',
              'This reservation is confirmed, so it cannot be cancelled.',
              { reservation: { ...exampleReservation, status: 'CONFIRMED', confirmed_at: '2026-09-12T08:05:00.000000+00:00', expired_at: null } },
            ),
            RESERVATION_EXPIRED: errorExample(
              'RESERVATION_EXPIRED',
              'This reservation has expired, so there is nothing to cancel.',
              { reservation: exampleReservation },
            ),
          }),
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/v1/maintenance/expire-reservations': {
      post: {
        tags: ['Maintenance'],
        summary: 'Expire old reservations',
        description: [
          'Stores the status EXPIRED on every PENDING reservation whose `expires_at` has passed,',
          'and returns how many reservations this call changed. No request body is needed.',
          '',
          'Stock numbers already stop counting a PENDING reservation when its `expires_at` passes,',
          'so its quantity is available again even if this endpoint never runs. This endpoint makes the stored',
          'status match. It is safe to call many times: reservations that are already EXPIRED are not changed again.',
        ].join('\n'),
        responses: {
          '200': { description: 'Old reservations were expired.', content: jsonContent('ExpireReservationsResult') },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
  },
  components: {
    parameters: {
      ItemId: {
        name: 'id',
        in: 'path',
        required: true,
        description: 'Item id (UUID)',
        schema: { type: 'string', format: 'uuid' },
      },
      ReservationId: {
        name: 'id',
        in: 'path',
        required: true,
        description: 'Reservation id (UUID)',
        schema: { type: 'string', format: 'uuid' },
      },
    },
    schemas: {
      CreateItemRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'initial_quantity'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200, example: 'White T-Shirt' },
          initial_quantity: { type: 'integer', minimum: 1, maximum: 2147483647, example: 5 },
        },
      },
      Item: {
        type: 'object',
        required: ['id', 'name', 'total_quantity', 'created_at'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'White T-Shirt' },
          total_quantity: { type: 'integer', example: 5, description: 'Fixed starting stock.' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ItemStatus: {
        type: 'object',
        required: [
          'id',
          'name',
          'total_quantity',
          'available_quantity',
          'held_quantity',
          'confirmed_quantity',
          'created_at',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'White T-Shirt' },
          total_quantity: { type: 'integer', example: 5, description: 'Fixed starting stock.' },
          available_quantity: {
            type: 'integer',
            example: 2,
            description: 'Units free to reserve: total - held - confirmed.',
          },
          held_quantity: {
            type: 'integer',
            example: 2,
            description: 'Units in PENDING reservations whose expires_at is in the future.',
          },
          confirmed_quantity: { type: 'integer', example: 1, description: 'Units in CONFIRMED reservations.' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      CreateReservationRequest: {
        type: 'object',
        additionalProperties: false,
        required: ['item_id', 'customer_id', 'quantity'],
        properties: {
          item_id: { type: 'string', format: 'uuid' },
          customer_id: { type: 'string', minLength: 1, maxLength: 200, example: 'customer-alice' },
          quantity: { type: 'integer', minimum: 1, maximum: 2147483647, example: 2 },
        },
      },
      Reservation: {
        type: 'object',
        required: [
          'id',
          'item_id',
          'customer_id',
          'quantity',
          'status',
          'created_at',
          'expires_at',
          'confirmed_at',
          'cancelled_at',
          'expired_at',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          item_id: { type: 'string', format: 'uuid' },
          customer_id: { type: 'string', example: 'customer-alice' },
          quantity: { type: 'integer', example: 2 },
          status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'], example: 'PENDING' },
          created_at: { type: 'string', format: 'date-time' },
          expires_at: {
            type: 'string',
            format: 'date-time',
            description: 'Deadline. After this time a PENDING reservation no longer holds stock.',
          },
          confirmed_at: { type: ['string', 'null'], format: 'date-time', description: 'Set when CONFIRMED.' },
          cancelled_at: { type: ['string', 'null'], format: 'date-time', description: 'Set when CANCELLED.' },
          expired_at: { type: ['string', 'null'], format: 'date-time', description: 'Set when EXPIRED.' },
        },
      },
      ExpireReservationsResult: {
        type: 'object',
        required: ['expired_count', 'checked_at'],
        properties: {
          expired_count: {
            type: 'integer',
            example: 3,
            description: 'How many reservations this call changed to EXPIRED.',
          },
          checked_at: {
            type: 'string',
            format: 'date-time',
            description: 'Reservations with expires_at at or before this time were expired.',
          },
        },
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', example: 'INSUFFICIENT_STOCK' },
              message: { type: 'string', example: 'Not enough stock. Requested 3, available 1.' },
              details: { type: 'object', description: 'Extra information. Only present for some errors.' },
            },
          },
        },
      },
    },
    responses: {
      BadRequest: errorResponse('The request is not valid.', {
        VALIDATION_ERROR: errorExample('VALIDATION_ERROR', 'The request is not valid.', {
          problems: [{ field: 'initial_quantity', message: 'Too small: expected number to be >=1' }],
        }),
        INVALID_JSON: errorExample('INVALID_JSON', 'The request body is not valid JSON.'),
      }),
      ReservationNotFound: errorResponse('The reservation does not exist.', {
        RESERVATION_NOT_FOUND: errorExample(
          'RESERVATION_NOT_FOUND',
          'Reservation 6c1f0a52-3d5e-4b8a-9f3b-2a1d4c7e8f90 does not exist.',
        ),
      }),
      InternalError: errorResponse('Unexpected server or database error.', {
        INTERNAL_ERROR: errorExample('INTERNAL_ERROR', 'Something went wrong on the server.'),
      }),
    },
  },
};

// A small HTML page that loads Swagger UI (a pinned version) from a CDN and shows /openapi.json.
// We do not serve Swagger files from node_modules, because Vercel does not serve express.static() files.
export const swaggerUiHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Inventory Reservation API - Docs</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });
    </script>
  </body>
</html>`;
