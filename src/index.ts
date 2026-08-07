import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { processScheduledNotifications } from './services/notification-admin.service.js';

const SCHEDULED_POLL_INTERVAL_MS = 60_000;

async function main() {
  await prisma.$connect();
  console.log('Connected to database');

  // Poll for due scheduled notifications every minute (non-blocking, fire-and-forget).
  const timer = setInterval(() => {
    processScheduledNotifications().catch((err) => {
      console.error('Scheduled notification processing failed:', err);
    });
  }, SCHEDULED_POLL_INTERVAL_MS);
  timer.unref();

  // Process anything already due on startup.
  processScheduledNotifications().catch((err) => {
    console.error('Startup scheduled notification processing failed:', err);
  });

  app.listen(env.PORT, () => {
    console.log(`Server running on port ${env.PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});