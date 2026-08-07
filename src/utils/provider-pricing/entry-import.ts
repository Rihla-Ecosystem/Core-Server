/**
 * Phase 2F-C pure bigint entry-import conversion and validation.
 *
 * Converts an engine-domain rate card (the exact `ProviderRateCard` shape the
 * Phase 2C `validateRateCard` consumes, e.g. the static
 * `PROVIDER_RATE_CARD`) into the database row payload used by the Admin
 * import repository write. Pure and stateless:
 *
 *  - the whole card is validated through the existing pure engine validator
 *    (`validateRateCard`), so any imported card provably satisfies every
 *    engine invariant (token/unit rate shape, effective windows, alias
 *    collisions, provider derivation) before a single row is written;
 *  - every monetary number is a non-negative safe integer (already enforced
 *    by the engine validator) and is converted to an exact PostgreSQL
 *    `bigint` here — the database stores money as BIGINT, never as Float;
 *  - engine domain spellings are converted to DB-native spellings:
 *    `tier` `standard|batch|priority|fast_mode` → `STANDARD|BATCH|PRIORITY|
 *    FAST_MODE`, ISO dates → UTC-midnight `Date`s, alias arrays → JSON-ready
 *    arrays;
 *  - duplicate `(provider, model, tier)` identities are rejected with
 *    `IMPORT_DUPLICATE_IDENTITY`. The engine allows disjoint effective
 *    windows for one identity, but the database unique index is
 *    `(snapshotId, provider, model, tier)` (window excluded, aligned with
 *    `resolveRate`), so a single snapshot cannot hold two lines for one
 *    identity even with disjoint windows. This mirrors the read-side
 *    `rejectDuplicateIdentities` in `src/utils/provider-pricing/snapshot.ts`.
 *
 * Safety: the module never mutates its input, never imports the static rate
 * card, performs no repository/Prisma queries, and raises exactly one error
 * type (`ProviderRateCardImportError`).
 */

import type {
  ProviderRateCard,
  RateCardEntry,
  RateCardTier,
} from '../../types/provider-pricing.js';
import {
  RATE_CARD_CURRENCY,
  RATE_CARD_ENGINE_UNIT,
  RATE_CARD_SCHEMA_VERSION,
  RATE_CARD_STORAGE_UNIT,
} from '../../types/provider-pricing.js';
import { validateRateCard, RateCardValidationError } from './rate-card.js';

/** DB-native tier spellings (PostgreSQL enum ordinals). */
export type ImportedEntryTier = 'STANDARD' | 'BATCH' | 'PRIORITY' | 'FAST_MODE';

/** DB-native entry status (mirrors the engine status values). */
export type ImportedEntryStatus = 'STABLE' | 'PREVIEW' | 'DEPRECATED' | 'LIMITED_AVAILABILITY';

/** DB-native billing unit (mirrors the engine billing unit values). */
export type ImportedEntryBillingUnit = 'TOKEN' | 'IMAGE' | 'SECOND' | 'MINUTE' | 'CHARACTER';

/** DB-native cached-input accounting semantic (mirrors the engine values). */
export type ImportedCachedSemantic = 'DISJOINT' | 'INCLUDED_IN_INPUT';

/**
 * The database row payload produced for one imported entry. Monetary fields
 * are exact `bigint` (PostgreSQL BIGINT). NULL means the rate is
 * unpublished/absent; an explicit zero is `0n`.
 */
export interface ImportedEntryRow {
  provider: string;
  model: string;
  status: ImportedEntryStatus;
  tier: ImportedEntryTier;
  billingUnit: ImportedEntryBillingUnit;
  inputMicrosPerMillion: bigint | null;
  outputMicrosPerMillion: bigint | null;
  cachedInputMicrosPerMillion: bigint | null;
  cachedOutputMicrosPerMillion: bigint | null;
  perUnitMicros: bigint | null;
  audioInputMicrosPerMillion: bigint | null;
  audioOutputMicrosPerMillion: bigint | null;
  tokensPerSecond: number | null;
  cachedInputAccounting: ImportedCachedSemantic | null;
  aliases: string[] | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  inactive: boolean;
  source: string | null;
  verifiedAt: Date | null;
}

/** Stable import-conversion error codes (Phase 2F-C). */
export type ProviderRateCardImportErrorCode =
  | 'IMPORT_INVALID_CARD'
  | 'IMPORT_DUPLICATE_IDENTITY';

/** Raised when an imported rate card cannot be converted to DB rows. */
export class ProviderRateCardImportError extends Error {
  constructor(
    message: string,
    readonly code: ProviderRateCardImportErrorCode,
  ) {
    super(`Provider rate card import failed: ${message}`);
    this.name = 'ProviderRateCardImportError';
  }
}

const TIER_TO_DB: Readonly<Record<RateCardTier, ImportedEntryTier>> = {
  standard: 'STANDARD',
  batch: 'BATCH',
  priority: 'PRIORITY',
  fast_mode: 'FAST_MODE',
};

function toUtcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** Reject duplicate (provider, model, tier) identities (DB unique identity). */
function rejectDuplicateIdentities(entries: readonly RateCardEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const tier = entry.tier ?? 'standard';
    const key = `${entry.provider}\u0000${entry.model.toLowerCase()}\u0000${tier}`;
    if (seen.has(key)) {
      throw new ProviderRateCardImportError(
        `duplicate entry identity provider="${entry.provider}" model="${entry.model}" tier=${tier} ` +
          '(the database unique identity is snapshotId + provider + model + tier, window excluded)',
        'IMPORT_DUPLICATE_IDENTITY',
      );
    }
    seen.add(key);
  }
}

function entryToRow(entry: RateCardEntry): ImportedEntryRow {
  const tokenRates = entry.tokenRates ?? {};
  return {
    provider: entry.provider.toLowerCase(),
    model: entry.model,
    status: entry.status,
    tier: TIER_TO_DB[entry.tier ?? 'standard'],
    billingUnit: entry.billingUnit,
    inputMicrosPerMillion:
      tokenRates.inputMicrosPerMillion === undefined ? null : BigInt(tokenRates.inputMicrosPerMillion),
    outputMicrosPerMillion:
      tokenRates.outputMicrosPerMillion === undefined ? null : BigInt(tokenRates.outputMicrosPerMillion),
    cachedInputMicrosPerMillion:
      tokenRates.cachedInputMicrosPerMillion === undefined
        ? null
        : BigInt(tokenRates.cachedInputMicrosPerMillion),
    cachedOutputMicrosPerMillion:
      tokenRates.cachedOutputMicrosPerMillion === undefined
        ? null
        : BigInt(tokenRates.cachedOutputMicrosPerMillion),
    perUnitMicros: entry.perUnitMicros === undefined ? null : BigInt(entry.perUnitMicros),
    audioInputMicrosPerMillion:
      entry.modalityRates?.audioInputMicrosPerMillion === undefined
        ? null
        : BigInt(entry.modalityRates.audioInputMicrosPerMillion),
    audioOutputMicrosPerMillion:
      entry.tts?.audioOutputMicrosPerMillion === undefined
        ? null
        : BigInt(entry.tts.audioOutputMicrosPerMillion),
    tokensPerSecond: entry.tts?.tokensPerSecond ?? null,
    cachedInputAccounting: entry.cachedInputAccounting ?? null,
    aliases: entry.aliases && entry.aliases.length > 0 ? [...entry.aliases] : null,
    effectiveFrom: toUtcDate(entry.effectiveFrom),
    effectiveTo: entry.effectiveTo ? toUtcDate(entry.effectiveTo) : null,
    inactive: entry.inactive,
    source: entry.source ?? null,
    verifiedAt: entry.verifiedAt ? toUtcDate(entry.verifiedAt) : null,
  };
}

/**
 * Validate an engine-domain rate card and convert it to DB entry rows.
 *
 * Returns the validated engine card (re-normalized), its derived provider
 * set, and the exact bigint row payload to persist. Throws
 * `ProviderRateCardImportError` with `IMPORT_INVALID_CARD` when the card
 * fails the pure engine validator, or `IMPORT_DUPLICATE_IDENTITY` when two
 * entries share the `(provider, model, tier)` DB identity. Never mutates its
 * input.
 */
export function convertRateCardForImport(raw: unknown): {
  card: ProviderRateCard;
  providers: string[];
  rows: ImportedEntryRow[];
} {
  let validated: { card: ProviderRateCard; providers: string[] };
  try {
    validated = validateRateCard(raw);
  } catch (error) {
    if (error instanceof RateCardValidationError) {
      throw new ProviderRateCardImportError(
        error.message.replace(/^Rate card validation failed:\s*/, ''),
        'IMPORT_INVALID_CARD',
      );
    }
    throw error;
  }

  rejectDuplicateIdentities(validated.card.entries);

  return {
    card: validated.card,
    providers: validated.providers,
    rows: validated.card.entries.map((entry) => entryToRow(entry)),
  };
}

/**
 * Build an engine-domain card around a raw `entries` array using the fixed
 * engine constants and a caller-supplied version/source/generatedAt, then
 * convert it to DB rows. Convenience for Admin imports that send only the
 * entries list (the snapshot-level fields live on the draft row).
 */
export function convertEntriesForImport(
  rawEntries: unknown,
  meta: { version: string; source: string; generatedAt: string },
): {
  card: ProviderRateCard;
  providers: string[];
  rows: ImportedEntryRow[];
} {
  return convertRateCardForImport({
    schemaVersion: RATE_CARD_SCHEMA_VERSION,
    currency: RATE_CARD_CURRENCY,
    storageUnit: RATE_CARD_STORAGE_UNIT,
    engineUnit: RATE_CARD_ENGINE_UNIT,
    version: meta.version,
    source: meta.source,
    generatedAt: meta.generatedAt,
    provenance: 'RESEARCH_SNAPSHOT',
    entries: rawEntries,
  });
}

// ---------------------------------------------------------------------------
// Admin wire conversion (strict non-negative integer money strings)
// ---------------------------------------------------------------------------

const MONEY_DIGITS = /^\d+$/;
const INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_ENGINE_RATE = BigInt(Number.MAX_SAFE_INTEGER);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function moneyError(name: string, reason: string): never {
  throw new ProviderRateCardImportError(`${name} ${reason}`, 'IMPORT_INVALID_CARD');
}

/**
 * Normalize one monetary field to an exact `bigint` (or null when absent).
 *
 * The Admin wire contract is strict non-negative integer strings: only
 * canonical digit strings such as "0", "1500000", "9000000000000000000" are
 * accepted, converted DIRECTLY to `bigint` — never through `Number` (so values
 * above Number.MAX_SAFE_INTEGER stay exact). Non-negative safe-integer JSON
 * numbers are still accepted for internal callers that bypass the HTTP wire
 * (e.g. the static-card import and direct service callers); a JSON `number`
 * is first range-checked as a safe integer and then converted exactly.
 *
 * Rejected: JSON numbers that are not non-negative safe integers, negative
 * strings, decimals, exponent notation, whitespace-padded values, empty
 * strings, and any value beyond PostgreSQL BIGINT (int64).
 */
function normalizeMoney(value: unknown, name: string): bigint | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      moneyError(name, 'must be a non-negative integer string (digits only) or a non-negative safe integer');
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    if (!MONEY_DIGITS.test(value)) {
      moneyError(name, 'must be a non-negative integer string (digits only, no sign/decimal/exponent/whitespace)');
    }
    const parsed = BigInt(value);
    if (parsed > MAX_ENGINE_RATE) {
      moneyError(name, 'must fit engine safe integer range (max 9007199254740991)');
    }
    if (parsed > INT64_MAX) {
      moneyError(name, 'must fit PostgreSQL BIGINT (int64)');
    }
    return parsed;
  }
  moneyError(name, 'must be a non-negative integer string (digits only) or a non-negative safe integer');
}

/**
 * Project one money bigint back to an engine-safe number for the structural
 * engine validation pass. Values beyond the engine's safe-number range are
 * clamped to MAX_SAFE_INTEGER — the clamp exists ONLY so the engine validator
 * can check the structural rules (enums, windows, aliases, exclusivity,
 * cached-semantic truthiness) without losing precision; the persisted value is
 * always the original exact `bigint` from `normalizeMoney`.
 */
function projectMoney(value: unknown, name: string): number | undefined {
  const normalized = normalizeMoney(value, name);
  if (normalized === null) return undefined;
  const clamped = normalized > MAX_ENGINE_RATE ? MAX_ENGINE_RATE : normalized;
  return Number(clamped);
}

/**
 * Build the engine-validation projection of one raw Admin entry: all money
 * fields become engine-safe numbers (null/absent stay absent). Every other
 * field is copied through unchanged for the engine validator to normalize.
 */
function projectEntryForEngine(entry: unknown, index: number): Record<string, unknown> {
  if (!isRecord(entry)) {
    throw new ProviderRateCardImportError(`entries[${index}] must be an object`, 'IMPORT_INVALID_CARD');
  }
  const name = `entries[${index}]`;
  const out: Record<string, unknown> = { ...entry };

  const rawToken = entry['tokenRates'];
  if (rawToken !== undefined && rawToken !== null) {
    if (!isRecord(rawToken)) {
      throw new ProviderRateCardImportError(`${name}.tokenRates must be an object`, 'IMPORT_INVALID_CARD');
    }
    const projected: Record<string, unknown> = {};
    for (const field of [
      'inputMicrosPerMillion',
      'outputMicrosPerMillion',
      'cachedInputMicrosPerMillion',
      'cachedOutputMicrosPerMillion',
    ] as const) {
      const v = projectMoney(rawToken[field], `${name}.tokenRates.${field}`);
      if (v !== undefined) projected[field] = v;
    }
    out['tokenRates'] = projected;
  }

  if (entry['perUnitMicros'] !== undefined && entry['perUnitMicros'] !== null) {
    const v = projectMoney(entry['perUnitMicros'], `${name}.perUnitMicros`);
    if (v !== undefined) out['perUnitMicros'] = v;
  }

  const rawModality = entry['modalityRates'];
  if (rawModality !== undefined && rawModality !== null) {
    if (!isRecord(rawModality)) {
      throw new ProviderRateCardImportError(`${name}.modalityRates must be an object`, 'IMPORT_INVALID_CARD');
    }
    const v = projectMoney(rawModality['audioInputMicrosPerMillion'], `${name}.modalityRates.audioInputMicrosPerMillion`);
    out['modalityRates'] = v === undefined ? {} : { audioInputMicrosPerMillion: v };
  }

  const rawTts = entry['tts'];
  if (rawTts !== undefined && rawTts !== null) {
    if (!isRecord(rawTts)) {
      throw new ProviderRateCardImportError(`${name}.tts must be an object`, 'IMPORT_INVALID_CARD');
    }
    const projected: Record<string, unknown> = { ...rawTts };
    const v = projectMoney(rawTts['audioOutputMicrosPerMillion'], `${name}.tts.audioOutputMicrosPerMillion`);
    if (v === undefined) delete projected['audioOutputMicrosPerMillion'];
    else projected['audioOutputMicrosPerMillion'] = v;
    out['tts'] = projected;
  }

  return out;
}

/** Build the exact bigint DB row payload for one raw Admin entry. */
function adminEntryToRow(entry: unknown, index: number): ImportedEntryRow {
  const raw = entry as Record<string, unknown>;
  const name = `entries[${index}]`;
  const tokenRates = raw['tokenRates'] as Record<string, unknown> | undefined;
  const modalityRates = raw['modalityRates'] as Record<string, unknown> | undefined;
  const tts = raw['tts'] as Record<string, unknown> | undefined;
  return {
    provider: String(raw['provider']).toLowerCase(),
    model: String(raw['model']),
    status: raw['status'] as ImportedEntryStatus,
    tier: TIER_TO_DB[(raw['tier'] ?? 'standard') as RateCardTier],
    billingUnit: raw['billingUnit'] as ImportedEntryBillingUnit,
    inputMicrosPerMillion: normalizeMoney(tokenRates?.['inputMicrosPerMillion'], `${name}.tokenRates.inputMicrosPerMillion`),
    outputMicrosPerMillion: normalizeMoney(tokenRates?.['outputMicrosPerMillion'], `${name}.tokenRates.outputMicrosPerMillion`),
    cachedInputMicrosPerMillion: normalizeMoney(tokenRates?.['cachedInputMicrosPerMillion'], `${name}.tokenRates.cachedInputMicrosPerMillion`),
    cachedOutputMicrosPerMillion: normalizeMoney(tokenRates?.['cachedOutputMicrosPerMillion'], `${name}.tokenRates.cachedOutputMicrosPerMillion`),
    perUnitMicros: normalizeMoney(raw['perUnitMicros'], `${name}.perUnitMicros`),
    audioInputMicrosPerMillion: normalizeMoney(modalityRates?.['audioInputMicrosPerMillion'], `${name}.modalityRates.audioInputMicrosPerMillion`),
    audioOutputMicrosPerMillion: normalizeMoney(tts?.['audioOutputMicrosPerMillion'], `${name}.tts.audioOutputMicrosPerMillion`),
    tokensPerSecond: (tts?.['tokensPerSecond'] as number | undefined) ?? null,
    cachedInputAccounting: (raw['cachedInputAccounting'] as ImportedCachedSemantic | undefined) ?? null,
    aliases: Array.isArray(raw['aliases']) && raw['aliases'].length > 0 ? [...(raw['aliases'] as string[])] : null,
    effectiveFrom: toUtcDate(String(raw['effectiveFrom'])),
    effectiveTo: raw['effectiveTo'] ? toUtcDate(String(raw['effectiveTo'])) : null,
    inactive: raw['inactive'] === true,
    source: raw['source'] !== undefined && raw['source'] !== null ? String(raw['source']) : null,
    verifiedAt: raw['verifiedAt'] ? toUtcDate(String(raw['verifiedAt'])) : null,
  };
}

/**
 * Convert an Admin wire entries array to exact bigint DB rows.
 *
 * Accepts money as strict non-negative integer STRINGS (the HTTP wire
 * contract) or non-negative safe-integer numbers (internal callers that bypass
 * the HTTP boundary, e.g. the static-card import). The whole card is validated
 * structurally through the pure engine validator on a clamped safe-number
 * projection, then every monetary value is converted DIRECTLY to `bigint` —
 * never through `Number` — so values above Number.MAX_SAFE_INTEGER stay exact.
 *
 * Throws `ProviderRateCardImportError` with `IMPORT_INVALID_CARD` on any
 * structural violation or malformed money, or `IMPORT_DUPLICATE_IDENTITY` on a
 * duplicate `(provider, model, tier)` identity.
 */
export function convertAdminEntriesForImport(
  rawEntries: unknown,
  meta: { version: string; source: string; generatedAt: string },
): {
  card: ProviderRateCard;
  providers: string[];
  rows: ImportedEntryRow[];
} {
  if (!Array.isArray(rawEntries)) {
    throw new ProviderRateCardImportError('entries must be an array', 'IMPORT_INVALID_CARD');
  }
  if (rawEntries.length === 0) {
    throw new ProviderRateCardImportError('entries must not be empty', 'IMPORT_INVALID_CARD');
  }

  const projected = rawEntries.map((entry, index) => projectEntryForEngine(entry, index));

  let validated: { card: ProviderRateCard; providers: string[] };
  try {
    validated = validateRateCard({
      schemaVersion: RATE_CARD_SCHEMA_VERSION,
      currency: RATE_CARD_CURRENCY,
      storageUnit: RATE_CARD_STORAGE_UNIT,
      engineUnit: RATE_CARD_ENGINE_UNIT,
      version: meta.version,
      source: meta.source,
      generatedAt: meta.generatedAt,
      provenance: 'RESEARCH_SNAPSHOT',
      entries: projected,
    });
  } catch (error) {
    if (error instanceof RateCardValidationError) {
      throw new ProviderRateCardImportError(
        error.message.replace(/^Rate card validation failed:\s*/, ''),
        'IMPORT_INVALID_CARD',
      );
    }
    throw error;
  }

  rejectDuplicateIdentities(validated.card.entries);
  const rows = rawEntries.map((entry, index) => adminEntryToRow(entry, index));
  return { card: validated.card, providers: validated.providers, rows };
}
