import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
});

export function resolveLocale(language: unknown): string {
  if (Array.isArray(language) && language.length > 0 && typeof language[0] === 'string') {
    return language[0].startsWith('ar') ? 'ar' : 'en';
  }
  return 'en';
}

export async function sendVerificationEmail(to: string, token: string, locale: string = 'en'): Promise<void> {
  const link = `${env.FRONTEND_URL}/${locale}/auth/verify-email?token=${token}`;
  await transporter.sendMail({
    from: env.EMAIL_FROM,
    to,
    subject: 'Verify your email',
    html: `<p>Click <a href="${link}">here</a> to verify your email address.</p>`,
  });
}

export async function sendPasswordResetEmail(to: string, token: string, locale: string = 'en'): Promise<void> {
  const link = `${env.FRONTEND_URL}/${locale}/auth/reset-password?token=${token}`;
  await transporter.sendMail({
    from: env.EMAIL_FROM,
    to,
    subject: 'Reset your password',
    html: `<p>Click <a href="${link}">here</a> to reset your password. This link expires in 1 hour.</p>`,
  });
}
