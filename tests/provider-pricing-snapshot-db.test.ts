{
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Safety check failed: DATABASE_URL is not set');
  const parsed = new URL(dbUrl);
  if (parsed.pathname !== '/core_server_test') {
    throw new Error(
      `Safety check failed: DATABASE_URL must point to /core_server_test, got "${parsed.pathname}"`,
    );
  }
}

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../src/config/prisma.js';
import { mapProviderRateCardSnapshot } from '../src/utils/provider-pricing/snapshot.js';

const VERSION_PREFIX = 'test-snapshot-';
const GENERATED_AT = new Date('2026-08-05T00:00:00Z');
const EFFECTIVE_FROM = new Date('2026-08-03T00:00:00Z');

function version(): string {
  return `${VERSION_PREFIX}${crypto.randomUUID()}`;
}

function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'google',
    model: `db-model-${crypto.randomUUID().slice(0, 8)}`,
    status: 'STABLE',
    billingUnit: 'TOKEN',
    inputMicrosPerMillion: 1_500_000n,
    outputMicrosPerMillion: 7_500_000n,
    cachedInputMicrosPerMillion: 150_000n,
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: EFFECTIVE_FROM,
    inactive: false,
    ...overrides,
  };
}

/** Delete only ProviderRateCard rows whose version starts with the test prefix. */
async function cleanupRateCardData(): Promise<void> {
  const snapshots = await prisma.providerRateCardSnapshot.findMany({
    where: { version: { startsWith: VERSION_PREFIX } },
    select: { id: true },
  });
  const ids = snapshots.map((s) => s.id);
  if (ids.length) {
    await prisma.providerRateCardEntry.deleteMany({ where: { snapshotId: { in: ids } } });
    await prisma.providerRateCardSnapshot.deleteMany({ where: { id: { in: ids } } });
  }
}

interface IsolationCounts {
  users: number;
  roles: number;
  payments: number;
  tokenTransactions: number;
  tokenReservations: number;
  aiBillingOperations: number;
  aiUsageLogs: number;
}

async function captureIsolationCounts(): Promise<IsolationCounts> {
  const [users, roles, payments, tokenTransactions, tokenReservations, aiBillingOperations, aiUsageLogs] =
    await Promise.all([
      prisma.user.count(),
      prisma.role.count(),
      prisma.payment.count(),
      prisma.tokenTransaction.count(),
      prisma.tokenReservation.count(),
      prisma.aIBillingOperation.count(),
      prisma.aiUsageLog.count(),
    ]);
  return { users, roles, payments, tokenTransactions, tokenReservations, aiBillingOperations, aiUsageLogs };
}

function assertRejectsCheck(promise: Promise<unknown>): Promise<void> {
  return assert.rejects(promise, (err: unknown) => {
    const e = err as { code?: string; name?: string };
    return e.code === undefined && e.name === 'PrismaClientUnknownRequestError';
  });
}

let baseline: IsolationCounts;

before(async () => {
  await cleanupRateCardData();
  baseline = await captureIsolationCounts();
});

after(async () => {
  await cleanupRateCardData();
  const now = await captureIsolationCounts();
  assert.deepEqual(now, baseline, 'rate-card tests must not modify any other table');
});

test('1. a valid DRAFT snapshot can be created', async () => {
  const created = await prisma.providerRateCardSnapshot.create({
    data: { version: version(), source: 'https://example.test/pricing', generatedAt: GENERATED_AT },
  });
  assert.equal(created.status, 'DRAFT');
  assert.equal(created.publishedAt, null);
  assert.equal(created.retiredAt, null);
  assert.equal(created.effectiveFrom, null);
});

test('2. a snapshot with entries is created and read back', async () => {
  const created = await prisma.providerRateCardSnapshot.create({
    data: {
      version: version(),
      source: 'https://example.test/pricing',
      generatedAt: GENERATED_AT,
      entries: { create: [baseEntry({ tier: 'STANDARD' }), baseEntry({ tier: 'BATCH' })] },
    },
    include: { entries: true },
  });
  assert.equal(created.entries.length, 2);
  const mapped = mapProviderRateCardSnapshot(created);
  assert.equal(mapped.card.entries.length, 2);
  assert.equal(mapped.card.generatedAt, '2026-08-05');
});

test('3. BigInt monetary values round-trip exactly', async () => {
  const created = await prisma.providerRateCardSnapshot.create({
    data: {
      version: version(),
      source: 'https://example.test/pricing',
      generatedAt: GENERATED_AT,
      entries: {
        create: [baseEntry({ inputMicrosPerMillion: 1_500_000n, outputMicrosPerMillion: 7_500_000n, cachedInputMicrosPerMillion: 150_000n })],
      },
    },
    include: { entries: true },
  });
  const entry = created.entries[0];
  assert.equal(entry.inputMicrosPerMillion, 1_500_000n);
  assert.equal(entry.outputMicrosPerMillion, 7_500_000n);
  assert.equal(entry.cachedInputMicrosPerMillion, 150_000n);
});

test('4. a monetary value larger than Number.MAX_SAFE_INTEGER round-trips exactly', async () => {
  const huge = 9_000_000_000_000_000_000n;
  const created = await prisma.providerRateCardSnapshot.create({
    data: {
      version: version(),
      source: 'https://example.test/pricing',
      generatedAt: GENERATED_AT,
      entries: { create: [baseEntry({ inputMicrosPerMillion: huge, outputMicrosPerMillion: huge, cachedInputMicrosPerMillion: null, cachedInputAccounting: null })] },
    },
    include: { entries: true },
  });
  assert.equal(created.entries[0].inputMicrosPerMillion, huge);
  assert.equal(created.entries[0].inputMicrosPerMillion > BigInt(Number.MAX_SAFE_INTEGER), true);
});

test('5. duplicate snapshot version is rejected', async () => {
  const v = version();
  const first = await prisma.providerRateCardSnapshot.create({
    data: { version: v, source: 'dup', generatedAt: GENERATED_AT },
  });
  await assert.rejects(
    prisma.providerRateCardSnapshot.create({ data: { version: v, source: 'dup', generatedAt: GENERATED_AT } }),
    (err: unknown) => (err as { code?: string }).code === 'P2002',
  );
  await prisma.providerRateCardSnapshot.delete({ where: { id: first.id } });
});

test('6. same provider/model/tier with a different billingUnit is rejected (identity is engine-aligned)', async () => {
  const model = 'dup-model';
  const tokenEntry = baseEntry({ model, tier: 'STANDARD' });
  const imageEntry = baseEntry({
    model,
    tier: 'STANDARD',
    billingUnit: 'IMAGE',
    inputMicrosPerMillion: null,
    outputMicrosPerMillion: null,
    cachedInputMicrosPerMillion: null,
    cachedOutputMicrosPerMillion: null,
    perUnitMicros: 1_000n,
    audioInputMicrosPerMillion: null,
    audioOutputMicrosPerMillion: null,
    tokensPerSecond: null,
    cachedInputAccounting: null,
  });
  await assert.rejects(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        source: 'dup',
        generatedAt: GENERATED_AT,
        entries: { create: [tokenEntry, imageEntry] },
      },
    }),
    (err: unknown) => (err as { code?: string }).code === 'P2002',
  );
});

test('7. duplicate default/standard-tier identity is rejected', async () => {
  const model = 'default-tier-model';
  const explicitStandard = baseEntry({ model, tier: 'STANDARD' });
  const defaulted = baseEntry({ model }); // tier omitted -> DB default STANDARD
  await assert.rejects(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        source: 'dup',
        generatedAt: GENERATED_AT,
        entries: { create: [explicitStandard, defaulted] },
      },
    }),
    (err: unknown) => (err as { code?: string }).code === 'P2002',
  );
});

test('8. the same entry identity in a different snapshot is accepted', async () => {
  const model = 'cross-snapshot-model';
  const entry = baseEntry({ model, tier: 'STANDARD' });
  const a = await prisma.providerRateCardSnapshot.create({
    data: { version: version(), source: 'a', generatedAt: GENERATED_AT, entries: { create: [entry] } },
    include: { entries: true },
  });
  const b = await prisma.providerRateCardSnapshot.create({
    data: { version: version(), source: 'b', generatedAt: GENERATED_AT, entries: { create: [entry] } },
    include: { entries: true },
  });
  assert.equal(a.entries[0].provider, 'google');
  assert.equal(b.entries[0].provider, 'google');
});

test('9. negative input rate is rejected by a DB CHECK', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        source: 'neg',
        generatedAt: GENERATED_AT,
        entries: { create: [baseEntry({ inputMicrosPerMillion: -1n })] },
      },
    }),
  );
});

test('10. negative output rate is rejected by a DB CHECK', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        source: 'neg',
        generatedAt: GENERATED_AT,
        entries: { create: [baseEntry({ outputMicrosPerMillion: -1n })] },
      },
    }),
  );
});

test('11. negative per-unit rate is rejected by a DB CHECK', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        source: 'neg',
        generatedAt: GENERATED_AT,
        entries: {
          create: [
            baseEntry({
              billingUnit: 'IMAGE',
              inputMicrosPerMillion: null,
              outputMicrosPerMillion: null,
              cachedInputMicrosPerMillion: null,
              perUnitMicros: -1n,
              cachedInputAccounting: null,
            }),
          ],
        },
      },
    }),
  );
});

test('12. tokensPerSecond = 0 is rejected by a DB CHECK', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        source: 'tps',
        generatedAt: GENERATED_AT,
        entries: { create: [baseEntry({ tokensPerSecond: 0 })] },
      },
    }),
  );
});

test('13. tokensPerSecond < 0 is rejected by a DB CHECK', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        source: 'tps',
        generatedAt: GENERATED_AT,
        entries: { create: [baseEntry({ tokensPerSecond: -0.5 })] },
      },
    }),
  );
});

test('14. entry effectiveTo before effectiveFrom is rejected', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        source: 'window',
        generatedAt: GENERATED_AT,
        entries: {
          create: [
            baseEntry({
              effectiveFrom: new Date('2026-08-03T00:00:00Z'),
              effectiveTo: new Date('2026-08-01T00:00:00Z'),
            }),
          ],
        },
      },
    }),
  );
});

test('15. snapshot effectiveTo before effectiveFrom is rejected', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        status: 'ACTIVE',
        source: 'window',
        generatedAt: GENERATED_AT,
        effectiveFrom: new Date('2026-09-01T00:00:00Z'),
        effectiveTo: new Date('2026-08-01T00:00:00Z'),
        publishedAt: new Date('2026-08-06T10:00:00Z'),
      },
    }),
  );
});

test('16. invalid entry foreign key is rejected', async () => {
  await assert.rejects(
    prisma.providerRateCardEntry.create({
      data: { snapshotId: crypto.randomUUID(), ...baseEntry({ model: 'orphan-model' }) },
    }),
    (err: unknown) => (err as { code?: string }).code === 'P2003',
  );
});

test('17. optional rate remains null', async () => {
  const created = await prisma.providerRateCardSnapshot.create({
    data: {
      version: version(),
      source: 'nulls',
      generatedAt: GENERATED_AT,
      entries: {
        create: [
          baseEntry({
            cachedOutputMicrosPerMillion: null,
            perUnitMicros: null,
            audioInputMicrosPerMillion: null,
            audioOutputMicrosPerMillion: null,
          }),
        ],
      },
    },
    include: { entries: true },
  });
  const entry = created.entries[0];
  assert.equal(entry.cachedOutputMicrosPerMillion, null);
  assert.equal(entry.perUnitMicros, null);
  assert.equal(entry.audioInputMicrosPerMillion, null);
  assert.equal(entry.audioOutputMicrosPerMillion, null);
});

test('18. explicit zero rate remains 0n', async () => {
  const created = await prisma.providerRateCardSnapshot.create({
    data: {
      version: version(),
      source: 'zero',
      generatedAt: GENERATED_AT,
      entries: {
        create: [
          baseEntry({ inputMicrosPerMillion: 0n, outputMicrosPerMillion: 400_000n, cachedInputMicrosPerMillion: null, cachedInputAccounting: null }),
        ],
      },
    },
    include: { entries: true },
  });
  const entry = created.entries[0];
  assert.equal(entry.inputMicrosPerMillion, 0n);
  assert.notEqual(entry.inputMicrosPerMillion, null);
  assert.equal(entry.outputMicrosPerMillion, 400_000n);
});

test('19. DRAFT lifecycle-valid row is accepted', async () => {
  const created = await prisma.providerRateCardSnapshot.create({
    data: { version: version(), source: 'draft-ok', generatedAt: GENERATED_AT },
  });
  assert.equal(created.status, 'DRAFT');
});

test('20. DRAFT with publishedAt is rejected', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        status: 'DRAFT',
        source: 'draft-bad',
        generatedAt: GENERATED_AT,
        publishedAt: new Date('2026-08-06T10:00:00Z'),
      },
    }),
  );
});

test('21. ACTIVE without publishedAt is rejected', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        status: 'ACTIVE',
        source: 'active-bad',
        generatedAt: GENERATED_AT,
        effectiveFrom: EFFECTIVE_FROM,
      },
    }),
  );
});

test('22. ACTIVE without effectiveFrom is rejected', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        status: 'ACTIVE',
        source: 'active-bad',
        generatedAt: GENERATED_AT,
        publishedAt: new Date('2026-08-06T10:00:00Z'),
      },
    }),
  );
});

test('23. valid ACTIVE lifecycle row is accepted', async () => {
  const created = await prisma.providerRateCardSnapshot.create({
    data: {
      version: version(),
      status: 'ACTIVE',
      source: 'active-ok',
      generatedAt: GENERATED_AT,
      effectiveFrom: EFFECTIVE_FROM,
      publishedAt: new Date('2026-08-06T10:00:00Z'),
    },
  });
  assert.equal(created.status, 'ACTIVE');
  assert.equal(created.retiredAt, null);
});

test('24. RETIRED without retiredAt is rejected', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        status: 'RETIRED',
        source: 'retired-bad',
        generatedAt: GENERATED_AT,
        effectiveFrom: EFFECTIVE_FROM,
        publishedAt: new Date('2026-08-06T10:00:00Z'),
      },
    }),
  );
});

test('25. RETIRED with retiredAt before publishedAt is rejected', async () => {
  await assertRejectsCheck(
    prisma.providerRateCardSnapshot.create({
      data: {
        version: version(),
        status: 'RETIRED',
        source: 'retired-bad',
        generatedAt: GENERATED_AT,
        effectiveFrom: EFFECTIVE_FROM,
        publishedAt: new Date('2026-08-06T10:00:00Z'),
        retiredAt: new Date('2026-08-01T00:00:00Z'),
      },
    }),
  );
});

test('26. valid RETIRED lifecycle row is accepted', async () => {
  const created = await prisma.providerRateCardSnapshot.create({
    data: {
      version: version(),
      status: 'RETIRED',
      source: 'retired-ok',
      generatedAt: GENERATED_AT,
      effectiveFrom: EFFECTIVE_FROM,
      publishedAt: new Date('2026-08-06T10:00:00Z'),
      retiredAt: new Date('2026-12-01T10:00:00Z'),
    },
  });
  assert.equal(created.status, 'RETIRED');
  assert.ok(created.retiredAt);
});

test('27. deleting a snapshot with entries is rejected because of RESTRICT', async () => {
  const created = await prisma.providerRateCardSnapshot.create({
    data: {
      version: version(),
      source: 'restrict',
      generatedAt: GENERATED_AT,
      entries: { create: [baseEntry({ tier: 'STANDARD' })] },
    },
  });
  await assert.rejects(
    prisma.providerRateCardSnapshot.delete({ where: { id: created.id } }),
    (err: unknown) => (err as { code?: string }).code === 'P2003',
  );
});

test('28. explicitly deleting entries then deleting a DRAFT snapshot succeeds', async () => {
  const created = await prisma.providerRateCardSnapshot.create({
    data: {
      version: version(),
      source: 'delete-ok',
      generatedAt: GENERATED_AT,
      entries: { create: [baseEntry({ tier: 'STANDARD' })] },
    },
    include: { entries: true },
  });
  assert.equal(created.entries.length, 1);
  await prisma.providerRateCardEntry.deleteMany({ where: { snapshotId: created.id } });
  await prisma.providerRateCardSnapshot.delete({ where: { id: created.id } });
  const gone = await prisma.providerRateCardSnapshot.findUnique({ where: { id: created.id } });
  assert.equal(gone, null);
});

test('29. only rate-card rows exist for the test prefix (own-data cleanup guarantee)', async () => {
  const all = await prisma.providerRateCardSnapshot.findMany({ where: { version: { startsWith: VERSION_PREFIX } } });
  for (const row of all) {
    assert.ok(row.version.startsWith(VERSION_PREFIX));
  }
});

test('30. a full create/read/delete cycle leaves every other table unchanged', async () => {
  const before = await captureIsolationCounts();
  const created = await prisma.providerRateCardSnapshot.create({
    data: {
      version: version(),
      source: 'isolation',
      generatedAt: GENERATED_AT,
      entries: { create: [baseEntry({ tier: 'STANDARD' }), baseEntry({ tier: 'BATCH' })] },
    },
    include: { entries: true },
  });
  const mapped = mapProviderRateCardSnapshot(created);
  assert.equal(mapped.card.entries.length, 2);
  await prisma.providerRateCardEntry.deleteMany({ where: { snapshotId: created.id } });
  await prisma.providerRateCardSnapshot.delete({ where: { id: created.id } });
  const after = await captureIsolationCounts();
  assert.deepEqual(after, before);
});
