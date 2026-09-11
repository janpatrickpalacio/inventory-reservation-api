import express from 'express';
import { openApiDocument, swaggerUiHtml } from './docs';
import { errorHandler, routeNotFoundHandler } from './errors';
import { router } from './routes';

// Builds the Express application.
// Vercel finds this file (src/app.ts) and uses its default export. Locally, local.ts starts it.
const app = express();

app.disable('x-powered-by');

// Read JSON request bodies. 10 kB is far more than any valid request needs.
app.use(express.json({ limit: '10kb' }));

// Stock numbers change all the time, so browsers and proxies must not cache responses.
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/', (_req, res) => {
  res.json({ name: 'Inventory Reservation API', docs: '/docs', openapi: '/openapi.json' });
});

app.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});

app.get('/docs', (_req, res) => {
  res.type('html').send(swaggerUiHtml);
});

app.use(router);
app.use(routeNotFoundHandler);
app.use(errorHandler);

export default app;
