import { Request, Response, NextFunction } from 'express';
import * as authService from '../services/auth.service.js';

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password, display_name, gender, nationality, language, budget_level, arrival_date, departure_date, travel_style, interests, accommodation_type } = req.body;
    const user = await authService.registerUser({
      email,
      password,
      displayName: display_name,
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
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
}

export async function verifyEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const { token } = req.query as { token: string };
    await authService.verifyEmail(token);
    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    next(err);
  }
}

export async function resendVerification(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body;
    await authService.resendVerification(email);
    res.json({ message: 'If the email exists, a verification email has been sent' });
  } catch (err) {
    next(err);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;
    const ipAddress = req.ip;
    const deviceInfo = req.headers['user-agent'];
    const result = await authService.loginUser(email, password, ipAddress, deviceInfo);

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/api/auth',
    });

    res.json({ accessToken: result.accessToken, user: result.user });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction) {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      res.status(401).json({ error: 'No refresh token provided' });
      return;
    }

    const result = await authService.refreshTokens(refreshToken);

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/api/auth',
    });

    res.json({ accessToken: result.accessToken });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction) {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      await authService.logoutUser(refreshToken);
    }

    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

export async function logoutAll(req: Request, res: Response, next: NextFunction) {
  try {
    await authService.logoutAllUsers(req.user!.userId);
    res.clearCookie('refreshToken', { path: '/api/auth' });
    res.json({ message: 'Logged out of all devices' });
  } catch (err) {
    next(err);
  }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body;
    await authService.forgotPassword(email);
    res.json({ message: 'If an account with that email exists, a reset link has been sent' });
  } catch (err) {
    next(err);
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, new_password } = req.body;
    await authService.resetPassword(token, new_password);
    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    next(err);
  }
}
