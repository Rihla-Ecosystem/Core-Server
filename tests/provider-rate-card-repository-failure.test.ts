/**
 * Phase 2F-B repository failure-path tests (no database).
 *
 * A deliberately failing Prisma delegate proves the repository/loader never
 * misclassify unexpected database failures as NOT_FOUND / VERSION_NOT_FOUND /
 * ACTIVE_CONFLICT, never leak connection/credentials/URL text, and always
 * surface a stable `RATE_CARD_DATABASE_ERROR`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrismaProviderRateCardRepository } from '../src/repositories/provider-rate-card.repository.js';
import type {
  ProviderRateCardRepository,
  ProviderRateCardRepositoryClient,
} from '../src/repositories/provider-rate-card.repository.js';
import {
  loadActiveRateCardForDate,
  loadRateCardByVersion,
  createDefaultProviderRateCardLoaderDependencies,
  ProviderRateCardLoadError,
} from '../src/services/provider-rate-card-loader.service.js';
import type { ProviderRateCardLoaderDependencies } from '../src/services/provider-rate-card-loader.service.js';

function failingClient(boom: Error): ProviderRateCardRepositoryClient {
  return {
    providerRateCardSnapshot: {
      async findMany() {
        throw boom;
      },
      async findUnique() {
        throw boom;
      },
      async count() {
        throw boom;
      },
    } as unknown as ProviderRateCardRepositoryClient['providerRateCardSnapshot'],
  };
}

function asLoadError(err: unknown): ProviderRateCardLoadError {
  assert.ok(err instanceof ProviderRateCardLoadError, `expected ProviderRateCardLoadError, got ${String(err)}`);
  return err;
}

test('1. active-date failure -> RATE_CARD_DATABASE_ERROR (not NOT_FOUND)', async () => {
  const repository = createPrismaProviderRateCardRepository(failingClient(new Error('connection refused')));
  await assert.rejects(
    repository.findActiveSnapshotForDate('2026-08-15'),
    (err: unknown) => asLoadError(err).code === 'RATE_CARD_DATABASE_ERROR',
  );
});

test('2. version-lookup failure -> RATE_CARD_DATABASE_ERROR (not VERSION_NOT_FOUND)', async () => {
  const repository = createPrismaProviderRateCardRepository(failingClient(new Error('connection refused')));
  await assert.rejects(
    repository.findSnapshotByVersion('1.0.0'),
    (err: unknown) => asLoadError(err).code === 'RATE_CARD_DATABASE_ERROR',
  );
});

test('3. database failure text never leaks connection/credentials/URL details', async () => {
  const secret = 'postgresql://hacker:pw@10.0.0.1:5432/prod sslmode=verify-full';
  const repository = createPrismaProviderRateCardRepository(failingClient(new Error(secret)));
  try {
    await repository.findActiveSnapshotForDate('2026-08-15');
    assert.fail('expected RATE_CARD_DATABASE_ERROR');
  } catch (err) {
    const e = asLoadError(err);
    assert.equal(e.code, 'RATE_CARD_DATABASE_ERROR');
    assert.equal((e.message as string).includes('hacker'), false);
    assert.equal((e.message as string).includes('10.0.0.1'), false);
    assert.equal((e.message as string).includes('sslmode'), false);
  }
});

test('4. the raw cause is preserved as non-serialized metadata', async () => {
  const boom = new Error('raw cause');
  const repository = createPrismaProviderRateCardRepository(failingClient(boom));
  try {
    await repository.findSnapshotByVersion('1.0.0');
    assert.fail('expected RATE_CARD_DATABASE_ERROR');
  } catch (err) {
    const e = asLoadError(err);
    assert.equal(e.cause, boom);
  }
});

test('5. loader keeps a repository DATABASE_ERROR stable (no reclassification)', async () => {
  const repository: ProviderRateCardRepository = {
    async findActiveSnapshotForDate() {
      throw new ProviderRateCardLoadError('RATE_CARD_DATABASE_ERROR', 'could not load the active rate card for 2026-08-15', {
        pricingDate: '2026-08-15',
      });
    },
    async findSnapshotByVersion() {
      throw new ProviderRateCardLoadError('RATE_CARD_DATABASE_ERROR', 'could not load rate card version "1.0.0"');
    },
  };
  const deps: ProviderRateCardLoaderDependencies = createDefaultProviderRateCardLoaderDependencies(repository);
  await assert.rejects(
    loadActiveRateCardForDate(deps, '2026-08-15'),
    (err: unknown) => {
      const e = asLoadError(err);
      assert.equal(e.code, 'RATE_CARD_DATABASE_ERROR');
      assert.equal(e.pricingDate, '2026-08-15');
      return true;
    },
  );
});

test('6. count failure during conflict detection -> RATE_CARD_DATABASE_ERROR', async () => {
  const twoRows = [{ version: '1.0.0' }, { version: '2.0.0' }];
  const client: ProviderRateCardRepositoryClient = {
    providerRateCardSnapshot: {
      async findMany() {
        return twoRows as never;
      },
      async count() {
        throw new Error('connection refused');
      },
      async findUnique() {
        throw new Error('unused');
      },
    } as unknown as ProviderRateCardRepositoryClient['providerRateCardSnapshot'],
  };
  const repository = createPrismaProviderRateCardRepository(client);
  await assert.rejects(
    repository.findActiveSnapshotForDate('2026-08-15'),
    (err: unknown) => asLoadError(err).code === 'RATE_CARD_DATABASE_ERROR',
  );
});

test('7. empty results are outcomes, not errors (none / null)', async () => {
  const emptyClient: ProviderRateCardRepositoryClient = {
    providerRateCardSnapshot: {
      async findMany() {
        return [] as never;
      },
      async count() {
        return 0 as never;
      },
      async findUnique() {
        return null as never;
      },
    } as unknown as ProviderRateCardRepositoryClient['providerRateCardSnapshot'],
  };
  const repository = createPrismaProviderRateCardRepository(emptyClient);
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.deepEqual(selection, { kind: 'none' });
  assert.equal(await repository.findSnapshotByVersion('1.0.0'), null);
});
