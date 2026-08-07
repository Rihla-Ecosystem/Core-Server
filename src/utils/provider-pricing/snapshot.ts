/**
 * Phase 2F-A snapshot → engine rate-card mapper.
 *
 * Pure and stateless. Converts a persisted `ProviderRateCardSnapshot` row (DB
 * `Date`s, DB-native uppercase enum spellings, and exact PostgreSQL BIGINT
 * monetary rates) into the validated engine `ProviderRateCard` the Phase 2C
 * pricing engine consumes. The final output is always re-validated through
 * `validateRateCard`, so a mapped card provably satisfies every engine
 * invariant (token/unit rate coherence, effective windows, alias collisions,
 * provider derivation) before it can price a single call.
 *
 * DB → domain normalization done here:
 *  - `tier`: `STANDARD`/`BATCH`/`PRIORITY`/`FAST_MODE` →
 *    `standard`/`batch`/`priority`/`fast_mode`; null → engine default
 *    `standard` (matches the non-null `STANDARD` DB default).
 *  - `status`, `billingUnit`, `cachedInputAccounting`: DB spellings already
 *    match the engine domain and pass through after validation.
 *  - `effectiveFrom`/`effectiveTo`/`generatedAt`/`verifiedAt`: `Date` →
 *    ISO `YYYY-MM-DD` strings.
 *  - `aliases`: DB JSON → engine `string[]`.
 *
 * BigInt boundary (the engine consumes safe JS numbers):
 *  - every monetary `bigint` converts to a JS number ONLY inside
 *    `[0n, BigInt(Number.MAX_SAFE_INTEGER)]`;
 *  - out-of-range values are rejected with `SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE`
 *    — never truncated, never rounded, never `Number(value)` without the check;
 *  - NULL stays absent; an explicit `0n` stays an explicit engine zero.
 *
 * Lifecycle: the mapper validates the DRAFT / ACTIVE / RETIRED lifecycle
 * metadata (including the snapshot effective window) BEFORE mapping entries,
 * so a DRAFT can never pretend to be published and a RETIRED snapshot always
 * carries its retirement evidence.
 *
 * Safety: the mapper never mutates its input, never imports the static rate
 * card, performs no repository/Prisma queries, holds no provider allowlist,
 * and raises exactly one error type (`ProviderRateCardSnapshotError`). Entry
 * duplicate identities are rejected even for plain objects (the same rule the
 * database unique index enforces).
 */

import type {
  CachedInputAccountingSemantic,
  ProviderRateCard,
  RateCardBillingUnit,
  RateCardEntry,
  RateCardModalityRates,
  RateCardStatus,
  RateCardTier,
  RateCardTokenRates,
  RateCardTts,
} from '../../types/provider-pricing.js';
import type { ProviderRateCardSnapshotRow } from '../../types/provider-pricing-snapshot.js';
import type { ProviderRateCardSnapshotMappingErrorCode } from '../../types/provider-pricing-snapshot.js';
import { validateRateCard, RateCardValidationError } from './rate-card.js';

/** Raised when a snapshot row cannot be mapped to a valid engine rate card. */
export class ProviderRateCardSnapshotError extends Error {
  constructor(
    message: string,
    readonly code: ProviderRateCardSnapshotMappingErrorCode,
  ) {
    super(`Provider rate card snapshot mapping failed: ${message}`);
    this.name = 'ProviderRateCardSnapshotError';
  }
}

const SNAPSHOT_STATUS_VALUES: readonly string[] = ['DRAFT', 'ACTIVE', 'RETIRED'];

const ENTRY_STATUS_VALUES: readonly string[] = [
  'STABLE',
  'PREVIEW',
  'DEPRECATED',
  'LIMITED_AVAILABILITY',
];

const BILLING_UNIT_VALUES: readonly string[] = [
  'TOKEN',
  'IMAGE',
  'SECOND',
  'MINUTE',
  'CHARACTER',
];

const CACHED_SEMANTIC_VALUES: readonly string[] = ['DISJOINT', 'INCLUDED_IN_INPUT'];

const TIER_TO_DOMAIN: Readonly<Record<string, RateCardTier>> = {
  STANDARD: 'standard',
  BATCH: 'batch',
  PRIORITY: 'priority',
  FAST_MODE: 'fast_mode',
};

/** The largest JS safe integer as a BigInt (engine rate-card upper bound). */
const MAX_ENGINE_RATE = BigInt(Number.MAX_SAFE_INTEGER);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/** Formats a DB `Date` as an engine ISO `YYYY-MM-DD` string (UTC). */
export function isoDateOf(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new ProviderRateCardSnapshotError('invalid Date value', 'SNAPSHOT_ENTRY_INVALID');
  }
  return value.toISOString().slice(0, 10);
}

function toIsoDate(value: Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return isoDateOf(value);
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProviderRateCardSnapshotError(`${name} must be a non-empty string`, 'SNAPSHOT_INVALID');
  }
  return value.trim();
}

/**
 * Convert an exact BigInt monetary rate to the engine's safe-number contract.
 *
 * NULL/undefined stays absent; a non-bigint value is a structural violation.
 * Any bigint outside `[0n, BigInt(Number.MAX_SAFE_INTEGER)]` is rejected with
 * the stable `SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE` code — the engine would
 * silently corrupt it otherwise (BigInt(number) truncates). `Number(value)` is
 * only ever called after the range check.
 */
function requireEngineRate(value: unknown, name: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'bigint') {
    throw new ProviderRateCardSnapshotError(
      `${name} must be a bigint or null`,
      'SNAPSHOT_ENTRY_INVALID',
    );
  }
  if (value < 0n || value > MAX_ENGINE_RATE) {
    throw new ProviderRateCardSnapshotError(
      `${name} value ${value.toString()} is outside the engine safe-number range [0, ${Number.MAX_SAFE_INTEGER}]`,
      'SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE',
    );
  }
  return Number(value);
}

function parseAliases(raw: unknown, provider: string, model: string): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ProviderRateCardSnapshotError(
      `entry provider="${provider}" model="${model}" aliases must be an array of strings`,
      'SNAPSHOT_ENTRY_INVALID_ALIASES',
    );
  }
  const out: string[] = [];
  for (const alias of raw) {
    if (typeof alias !== 'string' || alias.trim().length === 0) {
      throw new ProviderRateCardSnapshotError(
        `entry provider="${provider}" model="${model}" aliases entries must be non-empty strings`,
        'SNAPSHOT_ENTRY_INVALID_ALIASES',
      );
    }
    out.push(alias.trim());
  }
  return out.length ? out : undefined;
}

function mapEntry(raw: unknown, index: number): RateCardEntry {
  if (!isRecord(raw)) {
    throw new ProviderRateCardSnapshotError(
      `entries[${index}] must be an object`,
      'SNAPSHOT_ENTRY_INVALID',
    );
  }

  const provider = requireNonEmptyString(raw['provider'], `entries[${index}].provider`).toLowerCase();
  const model = requireNonEmptyString(raw['model'], `entries[${index}].model`);

  const status = raw['status'];
  if (typeof status !== 'string' || !ENTRY_STATUS_VALUES.includes(status)) {
    throw new ProviderRateCardSnapshotError(
      `entries[${index}].status must be one of ${ENTRY_STATUS_VALUES.join(', ')}`,
      'SNAPSHOT_ENTRY_INVALID',
    );
  }

  const billingUnit = raw['billingUnit'];
  if (typeof billingUnit !== 'string' || !BILLING_UNIT_VALUES.includes(billingUnit)) {
    throw new ProviderRateCardSnapshotError(
      `entries[${index}].billingUnit must be one of ${BILLING_UNIT_VALUES.join(', ')}`,
      'SNAPSHOT_ENTRY_INVALID',
    );
  }

  // Null tier is the engine default `standard` (mirrors the non-null DB
  // STANDARD default so DB and plain-object input behave identically).
  let tier: RateCardTier | undefined;
  if (raw['tier'] !== null && raw['tier'] !== undefined) {
    const mapped = TIER_TO_DOMAIN[String(raw['tier'])];
    if (mapped === undefined) {
      throw new ProviderRateCardSnapshotError(
        `entries[${index}].tier must be one of ${Object.keys(TIER_TO_DOMAIN).join(', ')}`,
        'SNAPSHOT_ENTRY_INVALID',
      );
    }
    tier = mapped;
  }

  const tokenRates: RateCardTokenRates = {};
  for (const field of [
    'inputMicrosPerMillion',
    'outputMicrosPerMillion',
    'cachedInputMicrosPerMillion',
    'cachedOutputMicrosPerMillion',
  ] as const) {
    const value = raw[field];
    if (value === null || value === undefined) continue;
    const converted = requireEngineRate(value, `entries[${index}].${field}`);
    if (converted !== undefined) tokenRates[field] = converted;
  }

  let perUnitMicros: number | undefined;
  if (raw['perUnitMicros'] !== null && raw['perUnitMicros'] !== undefined) {
    perUnitMicros = requireEngineRate(raw['perUnitMicros'], `entries[${index}].perUnitMicros`);
  }

  const modalityRates: RateCardModalityRates = {};
  const audioInput = raw['audioInputMicrosPerMillion'];
  if (audioInput !== null && audioInput !== undefined) {
    const converted = requireEngineRate(audioInput, `entries[${index}].audioInputMicrosPerMillion`);
    if (converted !== undefined) modalityRates.audioInputMicrosPerMillion = converted;
  }

  const tts: RateCardTts = {};
  const audioOutput = raw['audioOutputMicrosPerMillion'];
  if (audioOutput !== null && audioOutput !== undefined) {
    const converted = requireEngineRate(audioOutput, `entries[${index}].audioOutputMicrosPerMillion`);
    if (converted !== undefined) tts.audioOutputMicrosPerMillion = converted;
  }
  const tokensPerSecond = raw['tokensPerSecond'];
  if (tokensPerSecond !== null && tokensPerSecond !== undefined) {
    if (typeof tokensPerSecond !== 'number' || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
      throw new ProviderRateCardSnapshotError(
        `entries[${index}].tokensPerSecond must be a positive finite number`,
        'SNAPSHOT_ENTRY_INVALID',
      );
    }
    tts.tokensPerSecond = tokensPerSecond;
  }

  const cachedInputAccounting = raw['cachedInputAccounting'];
  if (cachedInputAccounting !== null && cachedInputAccounting !== undefined) {
    if (
      typeof cachedInputAccounting !== 'string' ||
      !CACHED_SEMANTIC_VALUES.includes(cachedInputAccounting)
    ) {
      throw new ProviderRateCardSnapshotError(
        `entries[${index}].cachedInputAccounting must be one of ${CACHED_SEMANTIC_VALUES.join(', ')}`,
        'SNAPSHOT_ENTRY_INVALID',
      );
    }
  }

  const effectiveFromRaw = raw['effectiveFrom'];
  if (!isDate(effectiveFromRaw)) {
    throw new ProviderRateCardSnapshotError(
      `entries[${index}].effectiveFrom must be a Date`,
      'SNAPSHOT_ENTRY_INVALID',
    );
  }

  const aliases = parseAliases(raw['aliases'], provider, model);

  const entry: RateCardEntry = {
    provider,
    model,
    status: status as RateCardStatus,
    billingUnit: billingUnit as RateCardBillingUnit,
    effectiveFrom: isoDateOf(effectiveFromRaw),
    inactive: raw['inactive'] === true,
  };
  if (tier) entry.tier = tier;
  if (Object.keys(tokenRates).length) entry.tokenRates = tokenRates;
  if (perUnitMicros !== undefined) entry.perUnitMicros = perUnitMicros;
  if (Object.keys(modalityRates).length) entry.modalityRates = modalityRates;
  if (Object.keys(tts).length) entry.tts = tts;
  if (cachedInputAccounting !== null && cachedInputAccounting !== undefined) {
    entry.cachedInputAccounting = cachedInputAccounting as CachedInputAccountingSemantic;
  }
  const effectiveTo = toIsoDate(raw['effectiveTo'] as Date | null | undefined);
  if (effectiveTo) entry.effectiveTo = effectiveTo;
  if (aliases) entry.aliases = aliases;
  const source = raw['source'];
  if (typeof source === 'string' && source.trim().length > 0) entry.source = source.trim();
  const verifiedAt = toIsoDate(raw['verifiedAt'] as Date | null | undefined);
  if (verifiedAt) entry.verifiedAt = verifiedAt;

  return entry;
}

/**
 * Validate the snapshot lifecycle metadata (DRAFT / ACTIVE / RETIRED) and the
 * snapshot business validity window. Throws `SNAPSHOT_LIFECYCLE_INVALID` on
 * the first violation.
 */
function validateSnapshotLifecycle(snapshot: Record<string, unknown>): void {
  const status = snapshot['status'];
  if (typeof status !== 'string' || !SNAPSHOT_STATUS_VALUES.includes(status)) {
    throw new ProviderRateCardSnapshotError(
      `snapshot.status must be one of ${SNAPSHOT_STATUS_VALUES.join(', ')}`,
      'SNAPSHOT_LIFECYCLE_INVALID',
    );
  }

  const publishedAt = snapshot['publishedAt'];
  const retiredAt = snapshot['retiredAt'];
  const effectiveFrom = snapshot['effectiveFrom'];

  if (publishedAt !== null && publishedAt !== undefined && !isDate(publishedAt)) {
    throw new ProviderRateCardSnapshotError(
      'snapshot.publishedAt must be a Date',
      'SNAPSHOT_LIFECYCLE_INVALID',
    );
  }
  if (retiredAt !== null && retiredAt !== undefined && !isDate(retiredAt)) {
    throw new ProviderRateCardSnapshotError(
      'snapshot.retiredAt must be a Date',
      'SNAPSHOT_LIFECYCLE_INVALID',
    );
  }
  if (effectiveFrom !== null && effectiveFrom !== undefined && !isDate(effectiveFrom)) {
    throw new ProviderRateCardSnapshotError(
      'snapshot.effectiveFrom must be a Date',
      'SNAPSHOT_LIFECYCLE_INVALID',
    );
  }

  const hasPublished = publishedAt instanceof Date;
  const hasRetired = retiredAt instanceof Date;
  const hasEffectiveFrom = effectiveFrom instanceof Date;

  if (status === 'DRAFT' && (hasPublished || hasRetired)) {
    throw new ProviderRateCardSnapshotError(
      'a DRAFT snapshot must not carry publishedAt or retiredAt',
      'SNAPSHOT_LIFECYCLE_INVALID',
    );
  }
  if (status === 'ACTIVE') {
    if (!hasPublished || !hasEffectiveFrom || hasRetired) {
      throw new ProviderRateCardSnapshotError(
        'an ACTIVE snapshot requires publishedAt and effectiveFrom and must not carry retiredAt',
        'SNAPSHOT_LIFECYCLE_INVALID',
      );
    }
  }
  if (status === 'RETIRED') {
    if (!hasPublished || !hasEffectiveFrom || !hasRetired) {
      throw new ProviderRateCardSnapshotError(
        'a RETIRED snapshot requires publishedAt, effectiveFrom and retiredAt',
        'SNAPSHOT_LIFECYCLE_INVALID',
      );
    }
    if (retiredAt.getTime() < publishedAt.getTime()) {
      throw new ProviderRateCardSnapshotError(
        'a RETIRED snapshot retiredAt must be >= publishedAt',
        'SNAPSHOT_LIFECYCLE_INVALID',
      );
    }
  }

  // Snapshot business validity window.
  const effectiveTo = snapshot['effectiveTo'];
  if (effectiveTo !== null && effectiveTo !== undefined) {
    if (!isDate(effectiveTo)) {
      throw new ProviderRateCardSnapshotError(
        'snapshot.effectiveTo must be a Date',
        'SNAPSHOT_LIFECYCLE_INVALID',
      );
    }
    if (!hasEffectiveFrom || effectiveTo.getTime() < effectiveFrom.getTime()) {
      throw new ProviderRateCardSnapshotError(
        'snapshot.effectiveTo must be >= effectiveFrom',
        'SNAPSHOT_LIFECYCLE_INVALID',
      );
    }
  }
}

/** Reject duplicate (provider, model, tier) identities, matching engine resolveRate. */
function rejectDuplicateIdentities(entries: readonly RateCardEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const tier = entry.tier ?? 'standard';
    const key = `${entry.provider}\u0000${entry.model.toLowerCase()}\u0000${tier}`;
    if (seen.has(key)) {
      throw new ProviderRateCardSnapshotError(
        `duplicate entry identity provider="${entry.provider}" model="${entry.model}" tier=${tier}`,
        'SNAPSHOT_DUPLICATE_ENTRY_IDENTITY',
      );
    }
    seen.add(key);
  }
}

/**
 * Map a persisted snapshot row to a validated engine rate card plus its
 * derived provider set. Throws `ProviderRateCardSnapshotError` on any
 * structural, lifecycle, enum-spelling, monetary-range, or rate-card invariant
 * violation. Never mutates its input.
 */
export function mapProviderRateCardSnapshot(
  snapshot: unknown,
): { card: ProviderRateCard; providers: string[] } {
  if (!isRecord(snapshot)) {
    throw new ProviderRateCardSnapshotError('snapshot must be an object', 'SNAPSHOT_INVALID');
  }

  const entriesRaw = snapshot['entries'];
  if (!Array.isArray(entriesRaw)) {
    throw new ProviderRateCardSnapshotError('snapshot.entries must be an array', 'SNAPSHOT_MISSING_ENTRIES');
  }
  if (entriesRaw.length === 0) {
    throw new ProviderRateCardSnapshotError('snapshot.entries must not be empty', 'SNAPSHOT_EMPTY_ENTRIES');
  }

  validateSnapshotLifecycle(snapshot);

  const version = requireNonEmptyString(snapshot['version'], 'version');
  const source = requireNonEmptyString(snapshot['source'], 'source');
  const generatedAt = snapshot['generatedAt'];
  if (!isDate(generatedAt)) {
    throw new ProviderRateCardSnapshotError('generatedAt must be a Date', 'SNAPSHOT_INVALID');
  }

  const entries = entriesRaw.map((entry, index) => mapEntry(entry, index));
  rejectDuplicateIdentities(entries);

  const rawCard: unknown = {
    schemaVersion: snapshot['schemaVersion'],
    currency: snapshot['currency'],
    storageUnit: snapshot['storageUnit'],
    engineUnit: snapshot['engineUnit'],
    version,
    source,
    generatedAt: isoDateOf(generatedAt),
    provenance: snapshot['provenance'],
    entries,
  };

  try {
    return validateRateCard(rawCard);
  } catch (error) {
    if (error instanceof RateCardValidationError) {
      throw new ProviderRateCardSnapshotError(
        error.message.replace(/^Rate card validation failed:\s*/, ''),
        'SNAPSHOT_INVALID_INVARIANT',
      );
    }
    throw error;
  }
}

export type { ProviderRateCardSnapshotRow };
