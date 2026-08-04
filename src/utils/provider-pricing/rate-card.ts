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
  RateResolution,
} from '../../types/provider-pricing.js';
import {
  RATE_CARD_CURRENCY,
  RATE_CARD_ENGINE_UNIT,
  RATE_CARD_SCHEMA_VERSION,
  RATE_CARD_STORAGE_UNIT,
} from '../../types/provider-pricing.js';

/**
 * Phase 2C rate-card validation and rate resolution.
 *
 * Pure and stateless. `validateRateCard` fails fast on a malformed card (no
 * mutation); `resolveRate` maps a canonical provider + canonical model +
 * alias + tier + effective date to exactly one active line, or an
 * `UNRESOLVED` instance carrying a provider-neutral `UnpricedReason`.
 *
 * The provider set is derived strictly from validated entries — there is no
 * closed provider list anywhere in the engine.
 */

export class RateCardValidationError extends Error {
  constructor(msg: string) {
    super(`Rate card validation failed: ${msg}`);
    this.name = 'RateCardValidationError';
  }
}

const TIER_VALUES: readonly RateCardTier[] = ['standard', 'batch', 'priority', 'fast_mode'];
const STATUS_VALUES: readonly RateCardStatus[] = [
  'STABLE',
  'PREVIEW',
  'DEPRECATED',
  'LIMITED_AVAILABILITY',
];
const BILLING_UNIT_VALUES: readonly RateCardBillingUnit[] = [
  'TOKEN',
  'IMAGE',
  'SECOND',
  'MINUTE',
  'CHARACTER',
];
const CACHED_SEMANTICS: readonly CachedInputAccountingSemantic[] = [
  'DISJOINT',
  'INCLUDED_IN_INPUT',
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validates an ISO date string (YYYY-MM-DD) and returns it, or throws. */
function requireIsoDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value.trim())) {
    throw new RateCardValidationError(`${name} must be an ISO date (YYYY-MM-DD)`);
  }
  const normalized = value.trim();
  const d = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new RateCardValidationError(`${name} is not a valid calendar date`);
  }
  return normalized;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RateCardValidationError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function validateTokenRates(raw: unknown, name: string): RateCardTokenRates | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new RateCardValidationError(`${name}.tokenRates must be an object`);
  }
  const ok: RateCardTokenRates = {};
  for (const field of [
    'inputMicrosPerMillion',
    'outputMicrosPerMillion',
    'cachedInputMicrosPerMillion',
    'cachedOutputMicrosPerMillion',
  ] as const) {
    const v = raw[field];
    if (v === undefined || v === null) continue;
    if (!isNonNegativeSafeInteger(v)) {
      throw new RateCardValidationError(`${name}.tokenRates.${field} must be a non-negative safe integer`);
    }
    ok[field] = v;
  }
  return ok;
}

function validateModalityRates(raw: unknown, name: string): RateCardModalityRates | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new RateCardValidationError(`${name}.modalityRates must be an object`);
  }
  const ok: RateCardModalityRates = {};
  const v = raw['audioInputMicrosPerMillion'];
  if (v !== undefined && v !== null) {
    if (!isNonNegativeSafeInteger(v)) {
      throw new RateCardValidationError(`${name}.modalityRates.audioInputMicrosPerMillion must be a non-negative safe integer`);
    }
    ok.audioInputMicrosPerMillion = v;
  }
  return ok;
}

function validateTts(raw: unknown, name: string): RateCardTts | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    throw new RateCardValidationError(`${name}.tts must be an object`);
  }
  const ok: RateCardTts = {};
  const rate = raw['audioOutputMicrosPerMillion'];
  if (rate !== undefined && rate !== null) {
    if (!isNonNegativeSafeInteger(rate)) {
      throw new RateCardValidationError(`${name}.tts.audioOutputMicrosPerMillion must be a non-negative safe integer`);
    }
    ok.audioOutputMicrosPerMillion = rate;
  }
  const tps = raw['tokensPerSecond'];
  if (tps !== undefined && tps !== null) {
    if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) {
      throw new RateCardValidationError(`${name}.tts.tokensPerSecond must be a positive finite number`);
    }
    ok.tokensPerSecond = tps;
  }
  return ok;
}

function validateCachedSemantic(
  raw: unknown,
  name: string,
  tokenRates: RateCardTokenRates | undefined,
): CachedInputAccountingSemantic | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !(CACHED_SEMANTICS as readonly string[]).includes(raw)) {
    throw new RateCardValidationError(`${name}.cachedInputAccounting must be 'DISJOINT' or 'INCLUDED_IN_INPUT'`);
  }
  if (!tokenRates?.cachedInputMicrosPerMillion) {
    throw new RateCardValidationError(`${name}.cachedInputAccounting set without a cachedInputMicrosPerMillion rate`);
  }
  return raw as CachedInputAccountingSemantic;
}

interface ValidatedEntry {
  entry: RateCardEntry;
  modelLookup: string;
  providerLookup: string;
  aliasLookups: string[];
}

function validateEntry(raw: unknown, index: number): ValidatedEntry {
  if (!isRecord(raw)) {
    throw new RateCardValidationError(`entries[${index}] must be an object`);
  }
  const provider = requireNonEmptyString(raw['provider'], `entries[${index}].provider`).toLowerCase();
  const model = requireNonEmptyString(raw['model'], `entries[${index}].model`);
  const modelLookup = model.toLowerCase();

  const status = raw['status'];
  if (typeof status !== 'string' || !(STATUS_VALUES as readonly string[]).includes(status)) {
    throw new RateCardValidationError(`entries[${index}].status must be one of ${STATUS_VALUES.join(', ')}`);
  }

  let tier: RateCardTier = 'standard';
  if (raw['tier'] !== undefined && raw['tier'] !== null) {
    if (typeof raw['tier'] !== 'string' || !(TIER_VALUES as readonly string[]).includes(raw['tier'])) {
      throw new RateCardValidationError(`entries[${index}].tier must be one of ${TIER_VALUES.join(', ')}`);
    }
    tier = raw['tier'] as RateCardTier;
  }

  const billingUnit = raw['billingUnit'];
  if (typeof billingUnit !== 'string' || !(BILLING_UNIT_VALUES as readonly string[]).includes(billingUnit)) {
    throw new RateCardValidationError(`entries[${index}].billingUnit must be one of ${BILLING_UNIT_VALUES.join(', ')}`);
  }

  const tokenRates = validateTokenRates(raw['tokenRates'], `entries[${index}]`);
  let perUnitMicros: number | undefined;
  if (raw['perUnitMicros'] !== undefined && raw['perUnitMicros'] !== null) {
    if (!isNonNegativeSafeInteger(raw['perUnitMicros'])) {
      throw new RateCardValidationError(`entries[${index}].perUnitMicros must be a non-negative safe integer`);
    }
    perUnitMicros = raw['perUnitMicros'];
  }
  const modalityRates = validateModalityRates(raw['modalityRates'], `entries[${index}]`);
  const tts = validateTts(raw['tts'], `entries[${index}]`);
  const cachedInputAccounting = validateCachedSemantic(raw['cachedInputAccounting'], `entries[${index}]`, tokenRates);

  const isToken = billingUnit === 'TOKEN';
  if (isToken) {
    if (perUnitMicros !== undefined) {
      throw new RateCardValidationError(`entries[${index}] TOKEN billing cannot also carry perUnitMicros`);
    }
    if (!tokenRates) {
      throw new RateCardValidationError(`entries[${index}] TOKEN billing requires tokenRates`);
    }
  } else {
    if (perUnitMicros === undefined) {
      throw new RateCardValidationError(`entries[${index}] ${billingUnit} billing requires perUnitMicros`);
    }
    if (tokenRates) {
      throw new RateCardValidationError(`entries[${index}] ${billingUnit} billing cannot also carry tokenRates`);
    }
    if (modalityRates || tts || cachedInputAccounting) {
      throw new RateCardValidationError(`entries[${index}] per-unit billing cannot carry token-module rates`);
    }
  }

  const effectiveFrom = requireIsoDate(raw['effectiveFrom'], `entries[${index}].effectiveFrom`);
  let effectiveTo: string | undefined;
  if (raw['effectiveTo'] !== undefined && raw['effectiveTo'] !== null) {
    effectiveTo = requireIsoDate(raw['effectiveTo'], `entries[${index}].effectiveTo`);
    if (effectiveTo < effectiveFrom) {
      throw new RateCardValidationError(`entries[${index}].effectiveTo must be >= effectiveFrom`);
    }
  }

  const inactive = raw['inactive'] === true;

  const aliases: string[] = [];
  const aliasRaw = raw['aliases'];
  if (aliasRaw !== undefined && aliasRaw !== null) {
    if (!Array.isArray(aliasRaw)) {
      throw new RateCardValidationError(`entries[${index}].aliases must be an array`);
    }
    for (const a of aliasRaw) {
      if (a === undefined || a === null) continue;
      if (typeof a !== 'string' || a.trim().length === 0) {
        throw new RateCardValidationError(`entries[${index}].aliases entries must be non-empty strings`);
      }
      if (/[*?]/.test(a)) {
        throw new RateCardValidationError(`entries[${index}].aliases must not contain wildcards`);
      }
      aliases.push(a.trim());
    }
  }
  const aliasLookups = aliases.map((a) => a.toLowerCase());

  const source = raw['source'] === undefined ? undefined : requireNonEmptyString(raw['source'], `entries[${index}].source`);
  const verifiedAt = raw['verifiedAt'] === undefined ? undefined : requireIsoDate(raw['verifiedAt'], `entries[${index}].verifiedAt`);

  const entry: RateCardEntry = {
    provider,
    model,
    status: status as RateCardStatus,
    tier,
    billingUnit: billingUnit as RateCardBillingUnit,
    effectiveFrom,
    effectiveTo,
    inactive,
  };
  if (tokenRates) entry.tokenRates = tokenRates;
  if (perUnitMicros !== undefined) entry.perUnitMicros = perUnitMicros;
  if (modalityRates) entry.modalityRates = modalityRates;
  if (tts) entry.tts = tts;
  if (cachedInputAccounting) entry.cachedInputAccounting = cachedInputAccounting;
  if (aliases.length) entry.aliases = aliases;
  if (source) entry.source = source;
  if (verifiedAt) entry.verifiedAt = verifiedAt;

  return { entry, modelLookup, providerLookup: provider, aliasLookups };
}

/** True when two inclusive effective windows overlap. */
function windowsOverlap(
  aFrom: string,
  aTo: string | undefined,
  bFrom: string,
  bTo: string | undefined,
): boolean {
  const aEnd = aTo ?? '9999-12-31';
  const bEnd = bTo ?? '9999-12-31';
  return aFrom <= bEnd && bFrom <= aEnd;
}

/**
 * Validate a full rate card and return it normalized with its derived
 * provider set. Throws `RateCardValidationError` on any violation; never
 * mutates the input.
 */
export function validateRateCard(card: unknown): { card: ProviderRateCard; providers: string[] } {
  if (!isRecord(card)) {
    throw new RateCardValidationError('rate card must be an object');
  }
  if (card['schemaVersion'] !== RATE_CARD_SCHEMA_VERSION) {
    throw new RateCardValidationError(`schemaVersion must be ${RATE_CARD_SCHEMA_VERSION}`);
  }
  if (card['currency'] !== RATE_CARD_CURRENCY) {
    throw new RateCardValidationError(`currency must be "${RATE_CARD_CURRENCY}"`);
  }
  if (card['storageUnit'] !== RATE_CARD_STORAGE_UNIT) {
    throw new RateCardValidationError(`storageUnit must be "${RATE_CARD_STORAGE_UNIT}"`);
  }
  if (card['engineUnit'] !== RATE_CARD_ENGINE_UNIT) {
    throw new RateCardValidationError(`engineUnit must be "${RATE_CARD_ENGINE_UNIT}"`);
  }
  const version = requireNonEmptyString(card['version'], 'version');
  const source = requireNonEmptyString(card['source'], 'source');
  const provenance = requireNonEmptyString(card['provenance'], 'provenance');
  if (provenance !== 'RESEARCH_SNAPSHOT') {
    throw new RateCardValidationError('provenance must be "RESEARCH_SNAPSHOT"');
  }
  requireIsoDate(card['generatedAt'], 'generatedAt');

  const rawEntries = card['entries'];
  if (!Array.isArray(rawEntries)) {
    throw new RateCardValidationError('entries must be an array');
  }
  if (rawEntries.length === 0) {
    throw new RateCardValidationError('entries must not be empty');
  }

  const validated = rawEntries.map((e, i) => validateEntry(e, i));
  const providers = [...new Set(validated.map((e) => e.providerLookup))];

  // Uniqueness + non-overlapping windows per provider + canonical model +
  // tier; alias 1:1 collision rejection within a provider.
  const windowKeys = new Map<string, Array<{ from: string; to?: string }>>();
  const aliasOwners = new Map<string, string>();
  for (const v of validated) {
    for (const aliasLookup of v.aliasLookups) {
      const key = `${v.providerLookup}\u0000${aliasLookup}`;
      const existing = aliasOwners.get(key);
      if (existing !== undefined && existing !== v.modelLookup) {
        throw new RateCardValidationError(
          `alias "${aliasLookup}" for provider "${v.providerLookup}" maps to more than one canonical model`,
        );
      }
      aliasOwners.set(key, v.modelLookup);
    }
    const key = `${v.providerLookup}\u0000${v.modelLookup}\u0000${v.entry.tier}`;
    const existingWindows = windowKeys.get(key) ?? [];
    for (const w of existingWindows) {
      if (windowsOverlap(w.from, w.to, v.entry.effectiveFrom, v.entry.effectiveTo)) {
        throw new RateCardValidationError(
          `overlapping effective windows for provider "${v.providerLookup}" model="${v.modelLookup}" tier=${v.entry.tier}`,
        );
      }
    }
    existingWindows.push({ from: v.entry.effectiveFrom, to: v.entry.effectiveTo });
    windowKeys.set(key, existingWindows);
  }

  const cardOut: ProviderRateCard = {
    schemaVersion: RATE_CARD_SCHEMA_VERSION,
    currency: RATE_CARD_CURRENCY,
    storageUnit: RATE_CARD_STORAGE_UNIT,
    engineUnit: RATE_CARD_ENGINE_UNIT,
    version,
    source,
    generatedAt: card['generatedAt'] as string,
    provenance,
    entries: validated.map((v) => v.entry),
  };
  return { card: cardOut, providers };
}

interface ResolveInput {
  /** Validated rate card. */
  card: ProviderRateCard;
  /** Canonical provider lookup key (trimmed + lowercased); may be undefined. */
  provider?: string;
  /** Canonical model lookup key (trimmed + lowercased) from identity selection. */
  modelLookupKey: string;
  /** Identity source driving the missing-model reason selection. */
  source: 'ACTUAL_MODEL' | 'REQUESTED_MODEL_FALLBACK';
  /** Requested tier; defaults to `standard`. */
  tier?: RateCardTier;
  /** ISO date the rate must be effective on. */
  pricingDate: string;
}

/**
 * Resolve a canonical model identity to exactly one active rate-card line.
 *
 * Order: provider has entries → exact canonical model → explicit alias →
 * requested tier (default `standard`) → effective window → not inactive.
 * Returns `UNRESOLVED` with the provider-neutral `UnpricedReason` otherwise.
 */
export function resolveRate(input: ResolveInput): RateResolution {
  const provider = input.provider?.trim().toLowerCase();
  const modelLookup = input.modelLookupKey.trim().toLowerCase();
  const tier = input.tier ?? 'standard';
  const date = requireIsoDate(input.pricingDate, 'pricingDate');

  const byProvider = new Map<string, ValidatedEntry[]>();
  for (const entry of input.card.entries) {
    const key = entry.provider.toLowerCase();
    const arr = byProvider.get(key) ?? [];
    arr.push({ entry, modelLookup: entry.model.toLowerCase(), providerLookup: key, aliasLookups: (entry.aliases ?? []).map((a) => a.toLowerCase()) });
    byProvider.set(key, arr);
  }

  if (!provider || !byProvider.has(provider)) {
    return { kind: 'UNRESOLVED', reason: 'PROVIDER_NOT_IN_RATECARD' };
  }

  const candidates = byProvider.get(provider)!.filter(
    (v) => v.modelLookup === modelLookup || v.aliasLookups.includes(modelLookup),
  );
  if (candidates.length === 0) {
    const reason =
      input.source === 'ACTUAL_MODEL'
        ? 'ACTUAL_MODEL_NOT_IN_RATECARD'
        : 'REQUESTED_MODEL_NOT_IN_RATECARD';
    return { kind: 'UNRESOLVED', reason };
  }

  const inWindow = candidates.filter((v) => {
    const { effectiveFrom, effectiveTo, inactive } = v.entry;
    if (inactive) return false;
    if (date < effectiveFrom) return false;
    if (effectiveTo !== undefined && date > effectiveTo) return false;
    return true;
  });

  const atTier = inWindow.filter((v) => v.entry.tier === tier);
  if (atTier.length === 0) {
    return { kind: 'UNRESOLVED', reason: 'RATE_NOT_ACTIVE' };
  }

  const applied = atTier[0].entry;
  return {
    kind: 'RESOLVED',
    provider: applied.provider,
    model: applied.model,
    modelLookupKey: applied.model.toLowerCase(),
    appliedTier: tier,
    entry: applied,
  };
}