import type { Request, Response, NextFunction } from 'express';
import {
  inspectTokenReservation as serviceInspectTokenReservation,
  listTokenReservations as serviceListTokenReservations,
} from '../services/admin-token-reservation.service.js';
import type { AdminTokenReservationListQuery } from '../schemas/admin-token-reservation.schema.js';

export async function listTokenReservations(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as unknown as AdminTokenReservationListQuery;
    const result = await serviceListTokenReservations(query);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function inspectTokenReservation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const reservationId = Array.isArray(req.params.reservationId)
      ? req.params.reservationId[0]
      : req.params.reservationId;
    const result = await serviceInspectTokenReservation(reservationId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
