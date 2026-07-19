import { prisma } from '../config/prisma.js';

export async function checkAndAwardBadges(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      userBadges: true,
    },
  });

  if (!user) return;

  const earnedBadgeIds = new Set(user.userBadges.map((ub: { badgeId: number }) => ub.badgeId));

  const allBadges = await prisma.badge.findMany();

  for (const badge of allBadges) {
    if (earnedBadgeIds.has(badge.id)) continue;

    let earned = false;

    if (badge.criteriaType === 'xp_threshold' && badge.criteriaValue !== null) {
      earned = user.xp >= badge.criteriaValue;
    }

    if (badge.criteriaType === 'manual') {
      if (badge.name === 'Welcome Aboard') {
        earned = true;
      }
      if (badge.name === 'Verified') {
        earned = user.isEmailVerified;
      }
    }

    if (badge.criteriaType === 'action_count' && badge.criteriaValue !== null) {
      if (badge.name === 'Century Club') {
        const count = await prisma.xpTransaction.count({
          where: { userId, reason: 'message_sent' },
        });
        earned = count >= badge.criteriaValue;
      }
    }

    if (earned) {
      await prisma.userBadge.create({
        data: { userId, badgeId: badge.id },
      });
    }
  }
}
