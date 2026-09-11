import app from './app';
import { config } from './config';

// Starts the API on your computer (npm run dev). Vercel does not use this file.
app.listen(config.port, (error?: Error) => {
  if (error) {
    throw error;
  }
  console.log(`Inventory Reservation API running at http://localhost:${config.port}`);
  console.log(`Swagger UI: http://localhost:${config.port}/docs`);
  console.log(`Reservations hold stock for ${config.reservationTtlSeconds} seconds`);
});
