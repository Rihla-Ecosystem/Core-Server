import { Router } from 'express';
import { prisma } from './prisma.js';
import { env } from './env.js';

let adminRouter: Router | null = null;

export async function getAdminRouter(): Promise<Router> {
  if (adminRouter) return adminRouter;

  const AdminJS = (await import('adminjs')).default;
  const { Database, Resource } = await import('@adminjs/prisma');
  AdminJS.registerAdapter({ Database, Resource } as any);

  const { Prisma } = await import('@prisma/client');
  // Patch prisma client for @adminjs/prisma v3 compatibility with Prisma v5+
  if (!(prisma as any)._baseDmmf) {
    (prisma as any)._baseDmmf = {
      modelMap: Prisma.dmmf.datamodel.models,
    };
  }

  const admin = new AdminJS({
    databases: [prisma],
    rootPath: '/admin-panel',
    loginPath: '/admin-panel/login',
    logoutPath: '/admin-panel/logout',
    refreshTokenPath: '/admin-panel/refresh-token',
    branding: { companyName: 'ITI Hub' },
  } as any);

  const adminjsExpressModule = (await import('@adminjs/express')) as any;
  const buildAuthRouter = adminjsExpressModule.buildAuthenticatedRouter || adminjsExpressModule.default?.buildAuthenticatedRouter;

  adminRouter = buildAuthRouter(
    admin,
    {
      authenticate: async (email: string, password: string) => {
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

  if (!adminRouter) {
    throw new Error('Failed to initialize admin router');
  }

  return adminRouter;
}
