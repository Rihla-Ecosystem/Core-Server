/**
 * Phase 2F-C pure semantic-parity comparator for provider rate-card snapshots.
 *
 * Decides whether two persisted snapshot rows are "the same rate card" for
 * admin workflow purposes (idempotent replay, static-import parity checks)
 * WITHOUT depending on database-generated fields. Pure and stateless:
 *
 *  - compares the full snapshot-level content (version, schemaVersion,
 *    currency, storageUnit, engineUnit, source, generatedAt, provenance,
 *    status, effectiveFrom, effectiveTo);
 *  - compares every entry on provider / model / tier / billingUnit / status /
 *    all monetary rates / tokensPerSecond / cachedInputAccounting / aliases /
 *    effectiveFrom / effectiveTo / source / verifiedAt / inactive;
 *  - is ORDER-INSENSITIVE for entries (a `Map` keyed by the unique
 *    `(provider, model, tier)` DB identity, with canonical per-entry payloads);
 *  - keeps NULL vs explicit zero DISTINCT for monetary rates (a `bigint`
 *    rate is compared as its exact string; `null` stays `null`);
 *  - normalizes only what is semantically equivalent: a `null` tier equals the
 *    `STANDARD` DB default (both map to the engine `standard` tier), and the
 *    `aliases` JSON array is compared as a sorted array;
 *  - IGNORES only database-generated fields: `id`, `snapshotId`, `createdAt`,
 *    `updatedAt`, and (unless `compareLifecycleTimestamps` is set) the
 *    lifecycle timestamps `publishedAt` / `retiredAt` — those are null for a
 *    freshly imported DRAFT by design;
 *  - NEVER mutates its inputs and performs no repository/Prisma/engine work.
 *
 * The comparison is a "content equality" check, NOT a validation: it never
 * calls the pure mapper or the engine validator. Two rows that compare equal
 * provably carry identical rate-card content.
 */

import type { ProviderRateCardSnapshotRow, ProviderRateCardEntryRow } from '../../types/provider-pricing-snapshot.js';

export interface RateCardSemanticParityOptions {
  /** Also require equal `publishedAt`/`retiredAt` timestamps (default false). */
  compareLifecycleTimestamps?: boolean;
}

const ISO_DATE_CACHE = new Map<string, string>();

function isoDateOf(date: Date): string {
  const key = String(date.getTime());
  let iso = ISO_DATE_CACHE.get(key);
  if (iso === undefined) {
    iso = date.toISOString().slice(0, 10);
    ISO_DATE_CACHE.set(key, iso);
  }
  return iso;
}

/** Canonical string for a rate: exact bigint digits or the null marker. */
function rateKey(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

/** Canonical string for a date: ISO `YYYY-MM-DD` or the null marker. */
function dateKey(value: Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return isoDateOf(value);
}

/** Sorted alias array (JSON-ready) — order-insensitive by construction. */
function aliasesKey(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  const raw = Array.isArray(value) ? value : [];
  return raw
    .filter((a): a is string => typeof a === 'string')
    .slice()
    .sort();
}

/** Canonical (order-insensitive) payload for one entry row. */
function entryKey(entry: ProviderRateCardEntryRow): string {
  const canonical = {
    provider: entry.provider,
    model: entry.model,
    // `null` tier is the DB default `STANDARD`; both map to engine `standard`.
    tier: entry.tier ?? 'STANDARD',
    billingUnit: entry.billingUnit,
    status: entry.status,
    inputMicrosPerMillion: rateKey(entry.inputMicrosPerMillion),
    outputMicrosPerMillion: rateKey(entry.outputMicrosPerMillion),
    cachedInputMicrosPerMillion: rateKey(entry.cachedInputMicrosPerMillion),
    cachedOutputMicrosPerMillion: rateKey(entry.cachedOutputMicrosPerMillion),
    perUnitMicros: rateKey(entry.perUnitMicros),
    audioInputMicrosPerMillion: rateKey(entry.audioInputMicrosPerMillion),
    audioOutputMicrosPerMillion: rateKey(entry.audioOutputMicrosPerMillion),
    tokensPerSecond: entry.tokensPerSecond,
    cachedInputAccounting: entry.cachedInputAccounting,
    aliases: aliasesKey(entry.aliases),
    effectiveFrom: dateKey(entry.effectiveFrom),
    effectiveTo: dateKey(entry.effectiveTo),
    inactive: entry.inactive,
    source: entry.source,
    verifiedAt: dateKey(entry.verifiedAt),
  };
  return JSON.stringify(canonical);
}

/**
 * List the semantic differences between two snapshot rows. An empty array
 * means the two rows carry identical rate-card content (ignoring only the
 * database-generated fields listed above). Pure: never mutates either input.
 */
export function semanticParityDifferences(
  a: ProviderRateCardSnapshotRow,
  b: ProviderRateCardSnapshotRow,
  options: RateCardSemanticParityOptions = {},
): string[] {
  const differences: string[] = [];

  const snapshotFields: Array<{
    name: string;
    av: unknown;
    bv: unknown;
  }> = [
    { name: 'version', av: a.version, bv: b.version },
    { name: 'schemaVersion', av: a.schemaVersion, bv: b.schemaVersion },
    { name: 'currency', av: a.currency, bv: b.currency },
    { name: 'storageUnit', av: a.storageUnit, bv: b.storageUnit },
    { name: 'engineUnit', av: a.engineUnit, bv: b.engineUnit },
    { name: 'source', av: a.source, bv: b.source },
    { name: 'generatedAt', av: dateKey(a.generatedAt), bv: dateKey(b.generatedAt) },
    { name: 'provenance', av: a.provenance, bv: b.provenance },
    { name: 'status', av: a.status, bv: b.status },
    { name: 'effectiveFrom', av: dateKey(a.effectiveFrom), bv: dateKey(b.effectiveFrom) },
    { name: 'effectiveTo', av: dateKey(a.effectiveTo), bv: dateKey(b.effectiveTo) },
  ];

  if (options.compareLifecycleTimestamps) {
    snapshotFields.push(
      { name: 'publishedAt', av: a.publishedAt, bv: b.publishedAt },
      { name: 'retiredAt', av: a.retiredAt, bv: b.retiredAt },
    );
  }

  for (const field of snapshotFields) {
    if (field.av !== field.bv) {
      differences.push(`snapshot.${field.name}: ${String(field.av)} != ${String(field.bv)}`);
    }
  }

  const entriesOf = (row: ProviderRateCardSnapshotRow): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const entry of row.entries) {
      const key = `${entry.provider}\u0000${entry.model.toLowerCase()}\u0000${entry.tier ?? 'STANDARD'}`;
      const list = map.get(key);
      if (list) list.push(entryKey(entry));
      else map.set(key, [entryKey(entry)]);
    }
    return map;
  };

  const aEntries = entriesOf(a);
  const bEntries = entriesOf(b);

  const aKeys = [...aEntries.keys()].sort();
  const bKeys = [...bEntries.keys()].sort();
  if (aKeys.join('\n') !== bKeys.join('\n')) {
    differences.push(`entry identity set differs: [${aKeys.join(', ')}] vs [${bKeys.join(', ')}]`);
  }

  for (const key of aKeys) {
    const aList = aEntries.get(key)?.slice().sort() ?? [];
    const bList = bEntries.get(key)?.slice().sort() ?? [];
    if (aList.join('\n') !== bList.join('\n')) {
      differences.push(
        `entries for identity "${key.replace(/\u0000/g, ' | ')}" differ: ` +
          `[${aList.join('] vs [')}]`,
      );
    }
  }

  return differences;
}

/** True when the two snapshot rows carry identical rate-card content. */
export function semanticParityEqual(
  a: ProviderRateCardSnapshotRow,
  b: ProviderRateCardSnapshotRow,
  options?: RateCardSemanticParityOptions,
): boolean {
  return semanticParityDifferences(a, b, options).length === 0;
}
