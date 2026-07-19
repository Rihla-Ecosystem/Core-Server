import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const roles = [
    { name: 'user', permissions: [] },
    { name: 'moderator', permissions: ['users:read', 'content:moderate'] },
    { name: 'admin', permissions: ['users:read', 'users:write', 'users:ban', 'roles:assign'] },
  ];

  for (const role of roles) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: { permissions: role.permissions },
      create: role,
    });
  }

  const badges = [
    { name: 'Welcome Aboard', description: 'Awarded at registration', criteriaType: 'manual', criteriaValue: null },
    { name: 'Verified', description: 'Awarded on email verification', criteriaType: 'manual', criteriaValue: null },
    { name: 'Getting Started', description: 'Reach 100 XP', criteriaType: 'xp_threshold', criteriaValue: 100 },
    { name: 'Power User', description: 'Reach 1000 XP', criteriaType: 'xp_threshold', criteriaValue: 1000 },
    { name: 'Century Club', description: 'Send 100 messages', criteriaType: 'action_count', criteriaValue: 100 },
  ];

  for (const badge of badges) {
    await prisma.badge.upsert({
      where: { name: badge.name },
      update: { description: badge.description, criteriaType: badge.criteriaType, criteriaValue: badge.criteriaValue },
      create: badge,
    });
  }

  console.log('Seeded roles and badges');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
