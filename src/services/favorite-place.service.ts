// ---------------------------------------------------------------------------
// Favorite Place Service
// ---------------------------------------------------------------------------
// User-saved places (monuments/sites) with a small snapshot so the saved page
// can render without a second lookup. A site is favorited at most once per user
// (unique userId + placeId); re-saves upsert the snapshot.
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';

export interface FavoritePlaceInput {
  placeId: string;
  placeName: string;
  category?: string;
  governorate?: string;
  lat?: number;
  lon?: number;
  img?: string;
}

function sanitize(favorite: {
  id: string;
  placeId: string;
  placeName: string;
  category: string | null;
  governorate: string | null;
  lat: number | null;
  lon: number | null;
  img: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: favorite.id,
    placeId: favorite.placeId,
    placeName: favorite.placeName,
    category: favorite.category,
    governorate: favorite.governorate,
    lat: favorite.lat,
    lon: favorite.lon,
    img: favorite.img,
    createdAt: favorite.createdAt.toISOString(),
    updatedAt: favorite.updatedAt.toISOString(),
  };
}

export async function listFavorites(userId: string) {
  const favorites = await prisma.favoritePlace.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
  });
  return favorites.map(sanitize);
}

export async function isFavorited(userId: string, placeId: string) {
  const favorite = await prisma.favoritePlace.findUnique({
    where: { userId_placeId: { userId, placeId } },
    select: { id: true },
  });
  return Boolean(favorite);
}

export async function addFavorite(userId: string, input: FavoritePlaceInput) {
  const { placeId, placeName } = input;
  if (!placeId || !placeName) {
    throw new AppError(400, 'place_id and place_name are required');
  }
  const favorite = await prisma.favoritePlace.upsert({
    where: { userId_placeId: { userId, placeId } },
    update: {
      placeName,
      category: input.category ?? null,
      governorate: input.governorate ?? null,
      lat: input.lat ?? null,
      lon: input.lon ?? null,
      img: input.img ?? null,
    },
    create: {
      userId,
      placeId,
      placeName,
      category: input.category ?? null,
      governorate: input.governorate ?? null,
      lat: input.lat ?? null,
      lon: input.lon ?? null,
      img: input.img ?? null,
    },
  });
  return sanitize(favorite);
}

export async function removeFavorite(userId: string, placeId: string) {
  const favorite = await prisma.favoritePlace.findUnique({
    where: { userId_placeId: { userId, placeId } },
    select: { id: true },
  });
  if (!favorite) {
    throw new AppError(404, 'Favorite not found');
  }
  await prisma.favoritePlace.delete({ where: { id: favorite.id } });
  return { removed: true };
}
