import { Request, Response, NextFunction } from 'express';
import * as memoryService from '../services/memory.service.js';

export async function listTrips(req: Request, res: Response, next: NextFunction) {
  try {
    const trips = await memoryService.listTrips(req.user!.userId);
    res.json(trips);
  } catch (err) { next(err); }
}

export async function createTrip(req: Request, res: Response, next: NextFunction) {
  try {
    const { title, destination, start_date, end_date, itinerary, notes } = req.body;
    const trip = await memoryService.createTrip(req.user!.userId, {
      title,
      destination,
      startDate: start_date,
      endDate: end_date,
      itinerary,
      notes,
    });
    res.status(201).json(trip);
  } catch (err) { next(err); }
}

export async function deleteTrip(req: Request, res: Response, next: NextFunction) {
  try {
    await memoryService.deleteTrip(req.user!.userId, req.params.id as string);
    res.json({ message: 'Trip deleted' });
  } catch (err) { next(err); }
}

export async function getPreferences(req: Request, res: Response, next: NextFunction) {
  try {
    const prefs = await memoryService.getPreferences(req.user!.userId);
    res.json(prefs);
  } catch (err) { next(err); }
}

export async function setPreference(req: Request, res: Response, next: NextFunction) {
  try {
    const { key, value } = req.body;
    await memoryService.setPreference(req.user!.userId, key, value);
    res.json({ message: 'Preference saved' });
  } catch (err) { next(err); }
}

export async function createFeedback(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, target_id, target_type, rating, comment } = req.body;
    const feedback = await memoryService.createFeedback(req.user!.userId, {
      type,
      targetId: target_id,
      targetType: target_type,
      rating,
      comment,
    });
    res.status(201).json(feedback);
  } catch (err) { next(err); }
}

export async function getSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const summary = await memoryService.getSummary(req.user!.userId);
    if (!summary) {
      res.json(null);
      return;
    }
    res.json(summary);
  } catch (err) { next(err); }
}
