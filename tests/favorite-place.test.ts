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

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../src/config/prisma.js';
import * as service from '../src/services/favorite-place.service.js';
import { AppError } from '../src/middleware/errorHandler.js';

let USER_ID: string;
const createdUserIds: string[] = [];

async function cleanup(): Promise<void> {
  await prisma.favoritePlace.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  createdUserIds.length = 0;
}

function input(placeId: string) {
  return {
    placeId,
    placeName: `Test Place ${placeId}`,
    category: 'archaeological',
    governorate: 'Giza',
    lat: 29.9792,
    lon: 31.1342,
    img: 'https://example.com/img.jpg',
  };
}

describe('Favorite place service', () => {
  before(async () => {
    await cleanup();
    const user = await prisma.user.create({
      data: {
        email: `test_fav_${crypto.randomUUID().slice(0, 8)}@test.example`,
        passwordHash: crypto.randomBytes(16).toString('hex'),
        displayName: 'Favorite Tester',
        gender: 'FEMALE',
        nationality: 'EG',
      } as never,
    });
    USER_ID = user.id;
    createdUserIds.push(user.id);
  });

  after(cleanup);

  test('adds a favorite with a snapshot', async () => {
    const fav = await service.addFavorite(USER_ID, input('site_alpha'));
    assert.ok(fav.id);
    assert.equal(fav.placeId, 'site_alpha');
    assert.equal(fav.placeName, 'Test Place site_alpha');
    assert.equal(fav.category, 'archaeological');
    assert.equal(fav.governorate, 'Giza');
    assert.equal(fav.lat, 29.9792);
  });

  test('listing returns saved favorites in recency order', async () => {
    await service.addFavorite(USER_ID, input('site_beta'));
    const list = await service.listFavorites(USER_ID);
    assert.equal(list.length, 2);
    assert.equal(list[0].placeId, 'site_beta');
    assert.equal(list[1].placeId, 'site_alpha');
  });

  test('isFavorited reflects membership', async () => {
    assert.equal(await service.isFavorited(USER_ID, 'site_alpha'), true);
    assert.equal(await service.isFavorited(USER_ID, 'site_missing'), false);
  });

  test('re-saving upserts instead of duplicating', async () => {
    await service.addFavorite(USER_ID, { ...input('site_alpha'), placeName: 'Renamed' });
    const list = await service.listFavorites(USER_ID);
    const alpha = list.filter((f) => f.placeId === 'site_alpha');
    assert.equal(alpha.length, 1);
    assert.equal(alpha[0].placeName, 'Renamed');
  });

  test('requires placeId and placeName', async () => {
    await assert.rejects(
      () => service.addFavorite(USER_ID, { placeId: '', placeName: 'x' }),
      (err: AppError) => err.statusCode === 400,
    );
    await assert.rejects(
      () => service.addFavorite(USER_ID, { placeId: 'x', placeName: '' }),
      (err: AppError) => err.statusCode === 400,
    );
  });

  test('removing a favorite deletes it', async () => {
    const result = await service.removeFavorite(USER_ID, 'site_beta');
    assert.deepEqual(result, { removed: true });
    assert.equal(await service.isFavorited(USER_ID, 'site_beta'), false);
  });

  test('removing an unknown favorite throws 404', async () => {
    await assert.rejects(
      () => service.removeFavorite(USER_ID, 'site_unknown'),
      (err: AppError) => err.statusCode === 404,
    );
  });

  test('favorites are scoped per user', async () => {
    const other = await prisma.user.create({
      data: {
        email: `test_fav2_${crypto.randomUUID().slice(0, 8)}@test.example`,
        passwordHash: crypto.randomBytes(16).toString('hex'),
        displayName: 'Other Tester',
        gender: 'MALE',
        nationality: 'US',
      } as never,
    });
    createdUserIds.push(other.id);
    assert.deepEqual(await service.listFavorites(other.id), []);
    assert.equal(await service.isFavorited(other.id, 'site_alpha'), false);
  });
});