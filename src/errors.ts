import type { ErrorRequestHandler, RequestHandler } from 'express';

// Every error response in this API has the same shape:
// { "error": { "code": "INSUFFICIENT_STOCK", "message": "...", "details": { ... } } }
// "details" is only present for some errors.

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Runs when no route matched the request.
export const routeNotFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.path} does not exist.` },
  });
};

// Express calls this for every error thrown in a route (Express 5 also catches errors from async routes).
// Express knows this is an error handler because it has 4 parameters, so "_next" must stay.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Errors from express.json() when the request body cannot be read.
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' } });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' } });
    return;
  }

  // Anything else is a bug or a database/network problem. Log the details on the server only.
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.' } });
};
