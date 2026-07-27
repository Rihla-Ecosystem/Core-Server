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

  const journey = await prisma.journey.upsert({
    where: { slug: 'scam-smart-traveler' },
    update: { title: 'Scam-Smart Traveler', description: 'Learn practical ways to recognize and avoid common travel scams in Egypt.', xpReward: 50, isActive: true },
    create: { slug: 'scam-smart-traveler', title: 'Scam-Smart Traveler', description: 'Learn practical ways to recognize and avoid common travel scams in Egypt.', xpReward: 50, isActive: true },
  });
  const steps = [
    { stepNumber: 1, title: 'Confirm the price and currency', content: 'Agree on the total price and currency before accepting a ride, service, or tour.', xpReward: 10 },
    { stepNumber: 2, title: 'Use official channels', content: 'Prefer official entrances, licensed guides, and app-based transport when available.', xpReward: 10 },
    { stepNumber: 3, title: 'Protect your documents and payment cards', content: 'Keep passports, cards, and PINs private; use secure payment methods.', xpReward: 10 },
    { stepNumber: 4, title: 'Pause when pressured', content: 'Walk away from unexpected urgency, free gifts, or requests to change the agreed deal.', xpReward: 10 },
    { stepNumber: 5, title: 'Know how to report a problem', content: 'Keep receipts and contact the official venue, accommodation, or local emergency service when needed.', xpReward: 10 },
  ];
  for (const step of steps) {
    await prisma.journeyStep.upsert({ where: { journeyId_stepNumber: { journeyId: journey.id, stepNumber: step.stepNumber } }, update: step, create: { ...step, journeyId: journey.id } });
  }
  await prisma.badge.upsert({
    where: { name: 'Scam-Smart Traveler' },
    update: { description: 'Complete the Scam-Smart Traveler journey', criteriaType: 'journey_complete', criteriaValue: null },
    create: { name: 'Scam-Smart Traveler', description: 'Complete the Scam-Smart Traveler journey', criteriaType: 'journey_complete' },
  });

  console.log('Seeded roles, badges, and journeys');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
