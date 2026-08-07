import { Prisma } from '@prisma/client';

/**
 * Serialize an arbitrary JS value into a Prisma InputJsonValue. Dates and
 * BigInts are stringified so the JSON column always stores plain JSON.
 */
export function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === null || value === undefined) {
    return Prisma.JsonNull as unknown as Prisma.InputJsonValue;
  }
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      typeof v === 'bigint' ? v.toString() : v instanceof Date ? v.toISOString() : v,
    ),
  ) as Prisma.InputJsonValue;
}

/** Alias for read-model usage where the source type is already Json-ish. */
export function asJsonValue(value: unknown): Prisma.InputJsonValue {
  return toInputJsonValue(value);
}