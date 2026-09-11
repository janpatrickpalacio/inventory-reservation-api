import { Router } from 'express';
import * as service from './service';
import { createItemSchema, createReservationSchema, idParamsSchema, validate } from './validation';

// HTTP layer: one handler per endpoint.
// Each handler does three things: validate the input, call the service, send the response.
// Anything thrown here goes to errorHandler in errors.ts.

export const router = Router();

router.post('/v1/items', async (req, res) => {
  const body = validate(createItemSchema, req.body);
  const item = await service.createItem(body.name, body.initial_quantity);
  res.status(201).json(item);
});

router.get('/v1/items/:id', async (req, res) => {
  const { id } = validate(idParamsSchema, req.params);
  const itemStatus = await service.getItemStatus(id);
  res.status(200).json(itemStatus);
});

router.post('/v1/reservations', async (req, res) => {
  const body = validate(createReservationSchema, req.body);
  const reservation = await service.createReservation(body);
  res.status(201).json(reservation);
});

router.post('/v1/reservations/:id/confirm', async (req, res) => {
  const { id } = validate(idParamsSchema, req.params);
  const reservation = await service.confirmReservation(id);
  res.status(200).json(reservation);
});

router.post('/v1/reservations/:id/cancel', async (req, res) => {
  const { id } = validate(idParamsSchema, req.params);
  const reservation = await service.cancelReservation(id);
  res.status(200).json(reservation);
});

router.post('/v1/maintenance/expire-reservations', async (_req, res) => {
  const summary = await service.expireReservations();
  res.status(200).json(summary);
});
