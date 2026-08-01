import { Router } from 'express';
import { prisma } from './prisma.js';
import { env } from './env.js';
import { verifyAdminLogin } from '../services/internal.service.js';

let adminRouter: Router | null = null;

export async function getAdminRouter(): Promise<Router> {
  if (adminRouter) return adminRouter;

  const AdminJS = (await import('adminjs')).default;
  const { Database, Resource } = await import('@adminjs/prisma');
  AdminJS.registerAdapter({ Database, Resource } as any);

  const admin = new AdminJS({
    databases: [{ client: prisma }],
    rootPath: '/admin-panel',
    loginPath: '/admin-panel/login',
    logoutPath: '/admin-panel/logout',
    refreshTokenPath: '/admin-panel/refresh-token',
    branding: { companyName: 'ITI Hub' },
  } as any);

  const { default: AdminJSExpress } = await import('@adminjs/express');

  adminRouter = AdminJSExpress.buildAuthenticatedRouter(
    admin,
    {
      authenticate: async (email: string, password: string) => {
        const result = await verifyAdminLogin(email, password);
        if (result.ok) {
          return { email, title: result.displayName || 'Admin' };
        }
        if (email === env.ADMIN_EMAIL && password === env.ADMIN_PASSWORD) {
          return { email, title: 'Admin' };
        }
        return null;
      },
      cookiePassword: env.ADMIN_SESSION_SECRET,
    },
    undefined,
    { secret: env.ADMIN_SESSION_SECRET, resave: false, saveUninitialized: false } as any,
  );

  return adminRouter;
}
