const EXPECTED_DB = '/core_server_dev';

async function main() {
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    throw new Error('DATABASE_URL is missing');
  }

  const parsed = new URL(dbUrl);

  if (parsed.pathname !== EXPECTED_DB) {
    throw new Error(
      `SAFETY STOP: this script only runs against ${EXPECTED_DB}. Current DB: ${parsed.pathname}`
    );
  }

  const { prisma } = await import('../src/config/prisma.js');
  const { grantBonus } = await import('../src/services/admin-token-wallet.service.js');
  const { reserveBusinessTokensForAmount } =
    await import('../src/services/token-reservation.service.js');
  const { TokenTransactionSource } = await import('@prisma/client');
  const { randomUUID } = await import('node:crypto');

  try {
    const admin = await prisma.user.findUnique({
      where: { email: 'admin@example.com' },
      select: { id: true, email: true },
    });

    if (!admin) {
      throw new Error('Seeded admin user was not found');
    }

    // Guard against an unexpected service signature before financial writes.
    if (grantBonus.length !== 3) {
      throw new Error(
        `Unexpected grantBonus signature: expected 3 arguments, got ${grantBonus.length}`
      );
    }

    const runId = randomUUID();

    // Use the real admin-wallet service so wallet + transaction +
    // funding lot remain consistent.
    await grantBonus(
      admin.id,
      admin.id,
      {
        tokens: 1000,
        reason: 'Billing Recovery local development fixtures',
        idempotencyKey: `billing-recovery-fixture-credit:${runId}`,
      },
    );

    const specs = [
      {
        label: 'KEEP_UNDER_REVIEW',
        feature: 'AI_CHAT_QUERY',
        source: TokenTransactionSource.CHAT,
        tokens: 100,
      },
      {
        label: 'MANUAL_RELEASE',
        feature: 'AI_IMAGE_ANALYSIS',
        source: TokenTransactionSource.IMAGE,
        tokens: 100,
      },
      {
        label: 'MANUAL_SETTLE',
        feature: 'REAL_TIME_TRANSLATION',
        source: TokenTransactionSource.VOICE,
        tokens: 100,
      },
    ] as const;

    const created = [];

    for (const spec of specs) {
      // Deliberately omit metadata.
      // Recovery should therefore treat these as MISSING/INVALID metadata,
      // requiring explicit admin recovery action.
      const reservation = await reserveBusinessTokensForAmount({
        userId: admin.id,
        feature: spec.feature,
        tokens: spec.tokens,
        source: spec.source,
        idempotencyKey: `billing-recovery-${spec.label}:${runId}`,
      });

      // Make it immediately recoverable instead of waiting for the 15-minute TTL.
      await prisma.tokenReservation.update({
        where: { id: reservation.reservationId },
        data: {
          expiresAt: new Date(Date.now() - 60_000),
        },
      });

      created.push({
        label: spec.label,
        reservationId: reservation.reservationId,
        tokens: reservation.tokens,
        status: reservation.status,
      });
    }

    const wallet = await prisma.tokenWallet.findUnique({
      where: { userId: admin.id },
      select: {
        id: true,
        tokenBalance: true,
      },
    });

    console.log('\n✅ Billing Recovery DEV fixtures created');
    console.table(created);

    console.log('\nWallet:', {
      id: wallet?.id,
      tokenBalance: wallet?.tokenBalance,
    });

    console.log('\nExpected accounting:');
    console.log('- 1000 points funded');
    console.log('- 300 points reserved across 3 PENDING reservations');
    console.log('- 3 reservations expired and ready for recovery inspection');
    console.log('- metadata intentionally missing');
    console.log('\nDatabase:', parsed.pathname);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('\n❌ Fixture creation failed');
  console.error(error);
  process.exitCode = 1;
});
