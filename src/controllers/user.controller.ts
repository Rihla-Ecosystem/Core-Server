import { Request, Response, NextFunction } from 'express';
import * as userService from '../services/user.service.js';

export async function getProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await userService.getUserProfile(req.user!.userId);
    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function updateProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const { display_name, avatar_url, bio, gender, nationality, language, budget_level, arrival_date, departure_date, travel_style, interests, accommodation_type } = req.body;
    const user = await userService.updateUserProfile(req.user!.userId, {
      displayName: display_name,
      avatarUrl: avatar_url,
      bio,
      gender,
      nationality,
      language,
      budgetLevel: budget_level,
      arrivalDate: arrival_date,
      departureDate: departure_date,
      travelStyle: travel_style,
      interests,
      accommodationType: accommodation_type,
    });
    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function deleteAccount(req: Request, res: Response, next: NextFunction) {
  try {
    await userService.deleteUserAccount(req.user!.userId);
    res.json({ message: 'Account deleted successfully' });
  } catch (err) {
    next(err);
  }
}

export async function uploadAvatar(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }
    const result = await userService.updateAvatar(req.user!.userId, req.file.buffer);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function removeAvatar(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await userService.deleteAvatar(req.user!.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getUserBadges(req: Request, res: Response, next: NextFunction) {
  try {
    const badges = await userService.getUserBadges(req.params.id as string);
    res.json(badges);
  } catch (err) {
    next(err);
  }
}

export async function getLeaderboard(req: Request, res: Response, next: NextFunction) {
  try {
    const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
    const leaderboard = await userService.getLeaderboard(limit);
    res.json(leaderboard);
  } catch (err) {
    next(err);
  }
}


// return all roles
export async function getAllRoles(req: Request, res: Response, next: NextFunction) {
  try {
    const roles = await userService.getAllRoles();
    res.json(roles);
  } catch (err) {
    next(err);
  }
}