/**
 * Phase 2F-C static rate-card DRAFT import script (test/prep only).
 *
 * Imports the static `PROVIDER_RATE_CARD` into the DATABASE_URL database as a
 * DRAFT snapshot under its EXACT version (`PROVIDER_RATE_CARD.version`), ready
 * for Admin workflow verification. This is deliberately NOT an HTTP endpoint:
 * the static card remains the only runtime pricing source and must never be
 * imported from a request.
 *
 * Safety gates (hard failures — there is NO bypass flag):
 *  1. DATABASE_URL must resolve to pathname `/core_server_test`. This script
 *     is test-only and will never run against the real database.
 *  2. The import is idempotent via the service contract:
 *       - version absent            -> create DRAFT + import entries;
 *       - identical DRAFT present   -> idempotent replay (no write);
 *       - different DRAFT present   -> RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT
 *                                      (the script NEVER deletes or overwrites);
 *       - ACTIVE/RETIRED present    -> RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT
 *                                      (published snapshots are never touched).
 *
 * Exit codes: 0 on created/idempotent-replay, 1 on any gate violation or
 * conflict, with a human-readable summary on stdout.
 */

import { PrismaClient } from '@prisma/client';
import { createPrismaProviderRateCardAdminRepository } from '../src/repositories/provider-rate-card-admin.repository.js';
import {
  importStaticRateCardAsDraft,
  createDefaultProviderRateCardAdminDependencies,
  PROVIDER_RATE_CARD,
} from '../src/services/admin-rate-card.service.js';
import { ProviderRateCardAdminError } from '../src/types/provider-rate-card-admin.js';

const SYSTEM_ACTOR_EMAIL = 'system.rate-card-import@core.test';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('FATAL: DATABASE_URL is not set');
  process.exit(1);
}

const parsed = new URL(dbUrl);
if (parsed.pathname !== '/core_server_test') {
  console.error(
    `FATAL: DATABASE_URL must point to /core_server_test (got "${parsed.pathname}") — ` +
      'this static-import script is test-only and refuses to touch any other database',
  );
  process.exit(1);
}

const prisma = new PrismaClient();
const repository = createPrismaProviderRateCardAdminRepository(prisma);
const deps = createDefaultProviderRateCardAdminDependencies(repository);

async function resolveSystemActorId(): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { email: SYSTEM_ACTOR_EMAIL } });
  if (existing) return existing.id;
  const created = await prisma.user.create({
    data: {
      email: SYSTEM_ACTOR_EMAIL,
      passwordHash: 'import-static-provider-rate-card-draft',
      displayName: 'Rate Card Static Import (test)',
      gender: 'MALE',
      nationality: 'TEST',
      roleId: 1,
    },
  });
  console.log(`static-import: created system actor id=${created.id}`);
  return created.id;
}

async function main(): Promise<void> {
  const expectedVersion = PROVIDER_RATE_CARD.version;
  const actorId = await resolveSystemActorId();
  const snapshotCount = await prisma.providerRateCardSnapshot.count();
  console.log(
    `static-import: DATABASE_URL=/core_server_test, snapshots before=${snapshotCount}, target version="${expectedVersion}"`,
  );

  const meta = await importStaticRateCardAsDraft(deps, {}, actorId);

  console.log(
    `static-import: ${meta.idempotentReplay ? 'IDEMPOTENT REPLAY (no write)' : 'CREATED'} ` +
      `version="${meta.version}" status=${meta.status} entryCount=${meta.entryCount}`,
  );
  console.log('static-import: OK');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err: unknown) => {
    try {
      if (err instanceof ProviderRateCardAdminError) {
        console.error(`static-import: FAILED code=${err.code} message="${err.message}"`);
        console.error('static-import: no snapshot was created or modified by this run');
      } else {
        console.error(`static-import: FAILED unexpected error=${String(err)}`);
      }
    } finally {
      await prisma.$disconnect();
    }
    process.exit(1);
  });
