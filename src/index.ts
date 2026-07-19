import app from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';

async function main() {
  await prisma.$connect();
  console.log('Connected to database');

  app.listen(env.PORT, () => {
    console.log(`Server running on port ${env.PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
