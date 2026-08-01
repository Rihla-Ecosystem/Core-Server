import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { checkAndAwardBadges } from './badge.service.js';

function computeLevel(totalXp: number): number {
  let level = 1;
  let cumulative = 0;
  while (true) {
    const needed = Math.round(100 * Math.pow(level, 1.5));
    if (totalXp < cumulative + needed) break;
    cumulative += needed;
    level++;
  }
  return level;
}

export async function addXp(userId: string, amount: number, reason: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });

      await tx.xpTransaction.create({
        data: { userId, amount, reason },
      });

      const newXp = user.xp + amount;
      const newLevel = computeLevel(newXp);

      await tx.user.update({
        where: { id: userId },
        data: { xp: newXp, level: newLevel },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  await checkAndAwardBadges(userId);
}
