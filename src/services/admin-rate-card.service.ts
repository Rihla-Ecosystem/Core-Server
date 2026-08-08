/**
 * Phase 2F-C Admin workflow service for provider rate-card snapshots.
 *
 * Pure orchestration over the Admin repository and the existing pure engine
 * contracts. The service:
 *  - validates canonical pricing dates (`YYYY-MM-DD`) and versions;
 *  - calls the repository only through its injected abstraction (never Prisma);
 *  - converts imported engine-domain cards to DB rows through the pure
 *    entry-import converter (bigint money, DB-native enum spellings);
 *  - validates a persisted DRAFT through the existing pure mapper before it
 *    can be published (and reports its stable mapping code when it cannot);
 *  - orchestrates the transactional DRAFT → ACTIVE (overlap-checked) and
 *    ACTIVE → RETIRED lifecycle, including explicit ACTIVE replacement
 *    (atomic retire + activate) and idempotent replay for both publish and
 *    retire (a coherent repeat returns the existing snapshot with
 *    `idempotentReplay: true` and writes nothing);
 *  - imports the static `PROVIDER_RATE_CARD` as a DRAFT only — never ACTIVE —
 *    under its exact version, idempotently (an already-imported identical
 *    DRAFT is replayed without a write; conflicting content or a published
 *    snapshot raises `RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT`), so the static
 *    card remains the only runtime pricing source;
 *  - builds fresh output objects (never leaks mutable Prisma references);
 *  - does NOT perform pricing arithmetic, model selection, caching, fallback,
 *    or any direct database write of its own.
 */

import type {
  ProviderRateCard,
  RateCardEntry,
} from '../types/provider-pricing.js';
import {
  RATE_CARD_CURRENCY,
  RATE_CARD_ENGINE_UNIT,
  RATE_CARD_SCHEMA_VERSION,
  RATE_CARD_STORAGE_UNIT,
} from '../types/provider-pricing.js';
import { PROVIDER_RATE_CARD, RATE_CARD_PROVIDERS } from '../config/provider-rate-card/index.js';
import type { ProviderRateCardSnapshotRow, ProviderRateCardEntryRow } from '../types/provider-pricing-snapshot.js';
import { ProviderRateCardAdminError } from '../types/provider-rate-card-admin.js';
import type { ProviderRateCardAdminErrorCode } from '../types/provider-rate-card-admin.js';
import { ProviderRateCardSnapshotError } from '../utils/provider-pricing/snapshot.js';
import { isoDateOf } from '../utils/provider-pricing/snapshot.js';
import { mapProviderRateCardSnapshot } from '../utils/provider-pricing/snapshot.js';
import { ProviderRateCardImportError } from '../utils/provider-pricing/entry-import.js';
import { convertAdminEntriesForImport } from '../utils/provider-pricing/entry-import.js';
import type { ImportedEntryRow } from '../utils/provider-pricing/entry-import.js';
import { semanticParityEqual } from '../utils/provider-pricing/semantic-parity.js';
import type {
  ProviderRateCardAdminRepository,
  AdminSnapshotListItem,
  AdminListQuery,
  AdminListResult,
} from '../repositories/provider-rate-card-admin.repository.js';

/** Safe snapshot metadata exposed by the Admin workflow (fresh plain object). */
export interface ProviderRateCardSnapshotMetadata {
  id: string;
  version: string;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  source: string;
  generatedAt: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  publishedAt: string | null;
  retiredAt: string | null;
  entryCount: number;
  createdAt: string;
  updatedAt: string;
  /**
   * True when the request was satisfied without a write because the target
   * already held the requested state (idempotent replay of publish/retire or
   * an already-imported static DRAFT).
   */
  idempotentReplay?: boolean;
}

/** Detail view: metadata + engine-domain entries + derived providers. */
export interface AdminRateCardSnapshotDetail extends ProviderRateCardSnapshotMetadata {
  entries: RateCardEntry[];
  providers: string[];
  mappingError: { code: string; message: string } | null;
}

export interface AdminRateCardListResult {
  items: ProviderRateCardSnapshotMetadata[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface AdminRateCardListQuery {
  page: number;
  limit: number;
  status?: 'DRAFT' | 'ACTIVE' | 'RETIRED';
}

export interface ProviderRateCardAdminDependencies {
  repository: ProviderRateCardAdminRepository;
}

export interface AdminDraftInput {
  version: string;
  source: string;
  generatedAt: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}

export interface AdminImportInput {
  version: string;
  source: string;
  generatedAt: string;
  entries: unknown[];
}

export interface AdminPublishInput {
  version: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  /** Explicit ACTIVE snapshot to replace atomically (retire + activate). */
  replaceActiveVersion?: string;
}

export interface AdminRetireInput {
  version: string;
  retiredAt?: string;
  /** Optional business-date window close written atomically with the retire. */
  effectiveTo?: string;
}

export interface AdminCloneInput {
  /** The immutable source snapshot version to clone pricing from. */
  sourceVersion: string;
  /** The new, unique DRAFT version that receives the copied pricing. */
  newVersion: string;
}

export interface AdminStaticImportInput {
  version?: string;
}

export interface DraftEntryCreateInput {
  version: string;
  entry: unknown;
}

export interface DraftEntryUpdateInput {
  version: string;
  entryId: string;
  patch: Record<string, unknown>;
}

export interface DraftEntryDeleteInput {
  version: string;
  entryId: string;
}

const AUDIT_ACTIONS = {
  draftCreated: 'rate_card_draft_created',
  entriesImported: 'rate_card_entries_imported',
  entryCreated: 'rate_card_entry_created',
  entryUpdated: 'rate_card_entry_updated',
  entryDeleted: 'rate_card_entry_deleted',
  published: 'rate_card_published',
  retired: 'rate_card_retired',
  staticImported: 'rate_card_static_imported',
  draftCloned: 'rate_card_draft_cloned',
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function adminError(
  code: ProviderRateCardAdminErrorCode,
  message: string,
  options: {
    version?: string;
    reason?: string;
    mapperCode?: string;
    entryCount?: number;
    snapshotCount?: number;
    conflictingVersions?: string[];
    cause?: unknown;
  } = {},
): ProviderRateCardAdminError {
  return new ProviderRateCardAdminError(code, message, options);
}

function requireVersion(version: string): string {
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw adminError(
      'RATE_CARD_ADMIN_INVALID_VERSION',
      'rate card version must be a non-empty string',
    );
  }
  return version.trim();
}

/** Strictly parse a canonical `YYYY-MM-DD` date into a UTC-midnight Date. */
function requireIsoDate(value: string, name: string): Date {
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed)) {
    throw adminError(
      'RATE_CARD_ADMIN_INVALID_WINDOW',
      `${name} must be an ISO date (YYYY-MM-DD)`,
    );
  }
  const date = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== trimmed) {
    throw adminError('RATE_CARD_ADMIN_INVALID_WINDOW', `${name} is not a valid calendar date`);
  }
  return date;
}

/** Strictly parse an ISO datetime string into a Date, or use now. */
function requireIsoDateTime(value: string | undefined): Date {
  if (value === undefined) return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw adminError('RATE_CARD_ADMIN_INVALID_WINDOW', 'retiredAt must be an ISO datetime string');
  }
  return date;
}

function metadataFromRow(row: ProviderRateCardSnapshotRow): ProviderRateCardSnapshotMetadata {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    source: row.source,
    generatedAt: isoDateOf(row.generatedAt),
    effectiveFrom: row.effectiveFrom ? isoDateOf(row.effectiveFrom) : null,
    effectiveTo: row.effectiveTo ? isoDateOf(row.effectiveTo) : null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    entryCount: row.entries.length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toListItem(item: AdminSnapshotListItem): ProviderRateCardSnapshotMetadata {
  return {
    id: item.id,
    version: item.version,
    status: item.status,
    source: item.source,
    generatedAt: isoDateOf(item.generatedAt),
    effectiveFrom: item.effectiveFrom ? isoDateOf(item.effectiveFrom) : null,
    effectiveTo: item.effectiveTo ? isoDateOf(item.effectiveTo) : null,
    publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
    retiredAt: item.retiredAt ? item.retiredAt.toISOString() : null,
    entryCount: item.entryCount,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function toListResult(result: AdminListResult): AdminRateCardListResult {
  return {
    items: result.items.map(toListItem),
    pagination: result.pagination,
  };
}

/** Build the default Admin dependencies backed by the Prisma repository. */
export function createDefaultProviderRateCardAdminDependencies(
  repository: ProviderRateCardAdminRepository,
): ProviderRateCardAdminDependencies {
  return { repository };
}

/**
 * Convert an import payload (Admin wire entries) to exact bigint DB rows,
 * mapping the pure import-conversion failures onto the stable Admin error
 * contract. Money arrives as strict non-negative integer strings on the wire
 * (or safe integers from internal callers) and is converted directly to
 * `bigint` — never through `Number`.
 */
function convertImport(payload: {
  version: string;
  source: string;
  generatedAt: string;
  entries: unknown[];
}): { rows: ImportedEntryRow[] } {
  try {
    const { rows } = convertAdminEntriesForImport(payload.entries, {
      version: payload.version,
      source: payload.source,
      generatedAt: payload.generatedAt,
    });
    return { rows };
  } catch (error) {
    if (error instanceof ProviderRateCardImportError) {
      if (error.code === 'IMPORT_DUPLICATE_IDENTITY') {
        throw adminError(
          'RATE_CARD_ADMIN_DUPLICATE_IDENTITY',
          error.message.replace(/^Provider rate card import failed:\s*/, ''),
          { version: payload.version },
        );
      }
      throw adminError(
        'RATE_CARD_ADMIN_INVALID_PAYLOAD',
        error.message.replace(/^Provider rate card import failed:\s*/, ''),
        { version: payload.version, reason: error.message },
      );
    }
    throw error;
  }
}

/** Map a persisted row through the pure mapper, raising DRAFT_NOT_PUBLISHABLE. */
function mapRowOrThrow(row: ProviderRateCardSnapshotRow): {
  card: ProviderRateCard;
  providers: string[];
} {
  try {
    return mapProviderRateCardSnapshot(row);
  } catch (error) {
    if (error instanceof ProviderRateCardSnapshotError) {
      throw adminError(
        'RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE',
        `rate card snapshot "${row.version}" could not be mapped to a valid engine rate card`,
        { version: row.version, mapperCode: error.code, cause: error },
      );
    }
    throw adminError(
      'RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE',
      `rate card snapshot "${row.version}" could not be mapped`,
      { version: row.version, cause: error },
    );
  }
}

function importedRowToEntryRow(
  row: ImportedEntryRow,
  snapshotId: string,
  index: number,
): ProviderRateCardEntryRow {
  return {
    id: `expected-${index}`,
    snapshotId,
    provider: row.provider,
    model: row.model,
    status: row.status,
    tier: row.tier,
    billingUnit: row.billingUnit,
    inputMicrosPerMillion: row.inputMicrosPerMillion,
    outputMicrosPerMillion: row.outputMicrosPerMillion,
    cachedInputMicrosPerMillion: row.cachedInputMicrosPerMillion,
    cachedOutputMicrosPerMillion: row.cachedOutputMicrosPerMillion,
    perUnitMicros: row.perUnitMicros,
    audioInputMicrosPerMillion: row.audioInputMicrosPerMillion,
    audioOutputMicrosPerMillion: row.audioOutputMicrosPerMillion,
    tokensPerSecond: row.tokensPerSecond,
    cachedInputAccounting: row.cachedInputAccounting,
    aliases: row.aliases,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    inactive: row.inactive,
    source: row.source,
    verifiedAt: row.verifiedAt,
  };
}

/**
 * Build the `ProviderRateCardSnapshotRow` that a fresh DRAFT import of the
 * static `PROVIDER_RATE_CARD` under `version` must look like. Used for the
 * idempotency parity check: a persisted DRAFT that semantically equals this
 * row (ignoring DB-generated fields) is the static card already imported.
 */
function buildExpectedStaticSnapshotRow(version: string, source: string, generatedAt: Date): ProviderRateCardSnapshotRow {
  const { rows } = convertImport({
    version,
    source,
    generatedAt: isoDateOf(generatedAt),
    entries: PROVIDER_RATE_CARD.entries,
  });
  return {
    id: 'expected',
    version,
    status: 'DRAFT',
    schemaVersion: RATE_CARD_SCHEMA_VERSION,
    currency: RATE_CARD_CURRENCY,
    storageUnit: RATE_CARD_STORAGE_UNIT,
    engineUnit: RATE_CARD_ENGINE_UNIT,
    source,
    generatedAt,
    provenance: 'RESEARCH_SNAPSHOT',
    effectiveFrom: null,
    effectiveTo: null,
    publishedAt: null,
    retiredAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    entries: rows.map((r, i) => importedRowToEntryRow(r, 'expected', i)),
  };
}

/** Create an empty DRAFT snapshot. */
export async function createDraftRateCard(
  deps: ProviderRateCardAdminDependencies,
  input: AdminDraftInput,
  actorId: string,
): Promise<ProviderRateCardSnapshotMetadata> {
  const version = requireVersion(input.version);
  const source = input.source.trim();
  if (source.length === 0) {
    throw adminError('RATE_CARD_ADMIN_INVALID_PAYLOAD', 'source must be a non-empty string');
  }
  const generatedAt = requireIsoDate(input.generatedAt, 'generatedAt');
  const effectiveFrom = input.effectiveFrom === undefined ? null : requireIsoDate(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo = input.effectiveTo === undefined ? null : requireIsoDate(input.effectiveTo, 'effectiveTo');
  if (effectiveFrom !== null && effectiveTo !== null && effectiveTo.getTime() < effectiveFrom.getTime()) {
    throw adminError('RATE_CARD_ADMIN_INVALID_WINDOW', 'effectiveTo must be >= effectiveFrom');
  }
  const row = await deps.repository.createDraft({
    version,
    source,
    generatedAt,
    effectiveFrom,
    effectiveTo,
    actorId,
    action: AUDIT_ACTIONS.draftCreated,
  });
  return metadataFromRow(row);
}

/**
 * Import entries into a DRAFT snapshot. The payload is an engine-domain card
 * (source, generatedAt, entries); the pure converter validates the whole card
 * and produces the exact bigint DB row payload. Imports atomically replace the
 * draft's entries (an admin edit, not an append).
 */
export async function importRateCardEntries(
  deps: ProviderRateCardAdminDependencies,
  input: AdminImportInput,
  actorId: string,
): Promise<ProviderRateCardSnapshotMetadata> {
  const version = requireVersion(input.version);
  const generatedAt = requireIsoDate(input.generatedAt, 'generatedAt');
  const { rows } = convertImport(input);

  const outcome = await deps.repository.importEntries({
    version,
    rows,
    source: input.source.trim(),
    generatedAt,
    actorId,
    action: AUDIT_ACTIONS.entriesImported,
  });

  if (outcome.kind === 'not_found') {
    throw adminError('RATE_CARD_ADMIN_NOT_FOUND', `rate card version "${version}" was not found`, {
      version,
    });
  }
  if (outcome.kind === 'not_draft') {
    throw adminError(
      'RATE_CARD_ADMIN_IMMUTABLE',
      `rate card version "${version}" is not a DRAFT and cannot be imported into`,
      { version },
    );
  }
  return metadataFromRow(outcome.snapshot);
}

function requireEntryId(entryId: string): string {
  if (typeof entryId !== 'string' || entryId.trim().length === 0) {
    throw adminError(
      'RATE_CARD_ADMIN_ENTRY_NOT_FOUND',
      'rate card entry id must be a non-empty string',
    );
  }
  return entryId.trim();
}

function assertDraftSnapshotOrThrow(
  version: string,
  snapshot: ProviderRateCardSnapshotRow | null,
): asserts snapshot is ProviderRateCardSnapshotRow {
  if (snapshot === null) {
    throw adminError('RATE_CARD_ADMIN_NOT_FOUND', `rate card version "${version}" was not found`, {
      version,
    });
  }
  if (snapshot.status !== 'DRAFT') {
    throw adminError(
      'RATE_CARD_ADMIN_IMMUTABLE',
      `rate card version "${version}" is not a DRAFT and its entries cannot be edited`,
      { version },
    );
  }
}

/** Convert a single engine-domain entry to one exact bigint DB row. */
function convertSingleEntry(
  entry: unknown,
  meta: { version: string; source: string; generatedAt: string },
): ImportedEntryRow {
  const { rows } = convertImport({
    version: meta.version,
    source: meta.source,
    generatedAt: meta.generatedAt,
    entries: [entry],
  });
  return rows[0];
}

/** Map a persisted entry row back to the engine-domain wire shape. */
function entryRowToWireEntry(row: ProviderRateCardEntryRow): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    provider: row.provider,
    model: row.model,
    status: row.status,
    tier: (row.tier ?? 'STANDARD').toLowerCase(),
    billingUnit: row.billingUnit,
    effectiveFrom: isoDateOf(row.effectiveFrom),
    inactive: row.inactive,
  };

  const tokenRates: Record<string, unknown> = {};
  if (row.inputMicrosPerMillion !== null) tokenRates.inputMicrosPerMillion = row.inputMicrosPerMillion.toString();
  if (row.outputMicrosPerMillion !== null) tokenRates.outputMicrosPerMillion = row.outputMicrosPerMillion.toString();
  if (row.cachedInputMicrosPerMillion !== null) tokenRates.cachedInputMicrosPerMillion = row.cachedInputMicrosPerMillion.toString();
  if (row.cachedOutputMicrosPerMillion !== null) tokenRates.cachedOutputMicrosPerMillion = row.cachedOutputMicrosPerMillion.toString();
  if (Object.keys(tokenRates).length > 0) entry.tokenRates = tokenRates;

  if (row.perUnitMicros !== null) entry.perUnitMicros = row.perUnitMicros.toString();

  if (row.audioInputMicrosPerMillion !== null) {
    entry.modalityRates = {
      audioInputMicrosPerMillion: row.audioInputMicrosPerMillion.toString(),
    };
  }

  const tts: Record<string, unknown> = {};
  if (row.audioOutputMicrosPerMillion !== null) {
    tts.audioOutputMicrosPerMillion = row.audioOutputMicrosPerMillion.toString();
  }
  if (row.tokensPerSecond !== null && row.tokensPerSecond !== undefined) {
    tts.tokensPerSecond = row.tokensPerSecond;
  }
  if (Object.keys(tts).length > 0) entry.tts = tts;

  if (row.cachedInputAccounting !== null) entry.cachedInputAccounting = row.cachedInputAccounting;
  if (Array.isArray(row.aliases) && row.aliases.length > 0) entry.aliases = [...row.aliases];
  if (row.effectiveTo !== null) entry.effectiveTo = isoDateOf(row.effectiveTo);
  if (row.source !== null) entry.source = row.source;
  if (row.verifiedAt !== null) entry.verifiedAt = isoDateOf(row.verifiedAt);

  return entry;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Merge a partial PATCH over an existing wire entry (sub-objects replace). */
function mergeEntryPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = { ...(out[key] as Record<string, unknown>), ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function mapEntryMutationOutcome(
  version: string,
  outcome:
    | { kind: 'created'; snapshot: ProviderRateCardSnapshotRow }
    | { kind: 'updated'; snapshot: ProviderRateCardSnapshotRow }
    | { kind: 'deleted'; snapshot: ProviderRateCardSnapshotRow }
    | { kind: 'not_found' }
    | { kind: 'not_draft' }
    | { kind: 'entry_not_found' }
    | { kind: 'duplicate_identity' },
): ProviderRateCardSnapshotMetadata {
  if (outcome.kind === 'not_found') {
    throw adminError('RATE_CARD_ADMIN_NOT_FOUND', `rate card version "${version}" was not found`, {
      version,
    });
  }
  if (outcome.kind === 'not_draft') {
    throw adminError(
      'RATE_CARD_ADMIN_IMMUTABLE',
      `rate card version "${version}" is not a DRAFT and its entries cannot be edited`,
      { version },
    );
  }
  if (outcome.kind === 'entry_not_found') {
    throw adminError(
      'RATE_CARD_ADMIN_ENTRY_NOT_FOUND',
      `rate card entry was not found in version "${version}"`,
      { version },
    );
  }
  if (outcome.kind === 'duplicate_identity') {
    throw adminError(
      'RATE_CARD_ADMIN_DUPLICATE_IDENTITY',
      `a rate card entry with the same provider, model, and tier already exists in version "${version}"`,
      { version },
    );
  }
  return metadataFromRow(outcome.snapshot);
}

/** Create a single entry in a DRAFT snapshot (idempotent by identity). */
export async function createDraftEntry(
  deps: ProviderRateCardAdminDependencies,
  input: DraftEntryCreateInput,
  actorId: string,
): Promise<ProviderRateCardSnapshotMetadata> {
  const version = requireVersion(input.version);
  const snapshot = await deps.repository.findSnapshotByVersion(version);
  assertDraftSnapshotOrThrow(version, snapshot);
  const row = convertSingleEntry(input.entry, {
    version,
    source: snapshot.source,
    generatedAt: isoDateOf(snapshot.generatedAt),
  });
  const outcome = await deps.repository.createEntry({
    version,
    row,
    actorId,
    action: AUDIT_ACTIONS.entryCreated,
  });
  return mapEntryMutationOutcome(version, outcome);
}

/** Update a single entry in a DRAFT snapshot (PATCH; validated whole). */
export async function updateDraftEntry(
  deps: ProviderRateCardAdminDependencies,
  input: DraftEntryUpdateInput,
  actorId: string,
): Promise<ProviderRateCardSnapshotMetadata> {
  const version = requireVersion(input.version);
  const entryId = requireEntryId(input.entryId);
  const snapshot = await deps.repository.findSnapshotByVersion(version);
  assertDraftSnapshotOrThrow(version, snapshot);
  const existing = snapshot.entries.find((entry) => entry.id === entryId);
  if (existing === undefined) {
    throw adminError(
      'RATE_CARD_ADMIN_ENTRY_NOT_FOUND',
      `rate card entry was not found in version "${version}"`,
      { version },
    );
  }
  const merged = mergeEntryPatch(entryRowToWireEntry(existing), input.patch);
  const row = convertSingleEntry(merged, {
    version,
    source: snapshot.source,
    generatedAt: isoDateOf(snapshot.generatedAt),
  });
  const outcome = await deps.repository.updateEntry({
    version,
    entryId,
    row,
    actorId,
    action: AUDIT_ACTIONS.entryUpdated,
  });
  return mapEntryMutationOutcome(version, outcome);
}

/** Delete a single entry from a DRAFT snapshot. */
export async function deleteDraftEntry(
  deps: ProviderRateCardAdminDependencies,
  input: DraftEntryDeleteInput,
  actorId: string,
): Promise<ProviderRateCardSnapshotMetadata> {
  const version = requireVersion(input.version);
  const entryId = requireEntryId(input.entryId);
  const snapshot = await deps.repository.findSnapshotByVersion(version);
  assertDraftSnapshotOrThrow(version, snapshot);
  if (!snapshot.entries.some((entry) => entry.id === entryId)) {
    throw adminError(
      'RATE_CARD_ADMIN_ENTRY_NOT_FOUND',
      `rate card entry was not found in version "${version}"`,
      { version },
    );
  }
  const outcome = await deps.repository.deleteEntry({
    version,
    entryId,
    actorId,
    action: AUDIT_ACTIONS.entryDeleted,
  });
  return mapEntryMutationOutcome(version, outcome);
}

/** Validate a persisted DRAFT: run the pure mapper and report publishability. */
export async function validateRateCardDraft(
  deps: ProviderRateCardAdminDependencies,
  version: string,
): Promise<{ valid: true; card: ProviderRateCard; providers: string[]; entryCount: number }> {
  const normalized = requireVersion(version);
  const row = await deps.repository.findSnapshotByVersion(normalized);
  if (row === null) {
    throw adminError('RATE_CARD_ADMIN_NOT_FOUND', `rate card version "${normalized}" was not found`, {
      version: normalized,
    });
  }
  const mapped = mapRowOrThrow(row);
  return {
    valid: true,
    card: mapped.card,
    providers: mapped.providers,
    entryCount: row.entries.length,
  };
}

/**
 * Publish a DRAFT snapshot. The window is taken from the request body when
 * provided, else from the draft's stored window; both must be coherent. The
 * repository performs the overlap-checked DRAFT → ACTIVE transition inside a
 * SERIALIZABLE transaction (or an explicit ACTIVE replacement that atomically
 * retires the superseded snapshot).
 *
 * Idempotent replay: publishing an already-ACTIVE snapshot whose persisted
 * window matches any window supplied in the request is a coherent no-op that
 * returns the existing snapshot with `idempotentReplay: true`. A conflicting
 * window on an already-ACTIVE snapshot, or any publish of a RETIRED snapshot,
 * is rejected with `RATE_CARD_ADMIN_DRAFT_REQUIRED`.
 */
export async function publishRateCard(
  deps: ProviderRateCardAdminDependencies,
  input: AdminPublishInput,
  actorId: string,
): Promise<ProviderRateCardSnapshotMetadata> {
  const version = requireVersion(input.version);
  const row = await deps.repository.findSnapshotByVersion(version);
  if (row === null) {
    throw adminError('RATE_CARD_ADMIN_NOT_FOUND', `rate card version "${version}" was not found`, {
      version,
    });
  }
  if (row.status === 'ACTIVE') {
    const fromCoherent =
      input.effectiveFrom === undefined ||
      (row.effectiveFrom !== null &&
        isoDateOf(requireIsoDate(input.effectiveFrom, 'effectiveFrom')) === isoDateOf(row.effectiveFrom));
    const toCoherent =
      input.effectiveTo === undefined ||
      (row.effectiveTo !== null &&
        isoDateOf(requireIsoDate(input.effectiveTo, 'effectiveTo')) === isoDateOf(row.effectiveTo));
    if (fromCoherent && toCoherent) {
      return { ...metadataFromRow(row), idempotentReplay: true };
    }
    throw adminError(
      'RATE_CARD_ADMIN_DRAFT_REQUIRED',
      `rate card version "${version}" must be a DRAFT to be published`,
      { version },
    );
  }
  if (row.status !== 'DRAFT') {
    throw adminError(
      'RATE_CARD_ADMIN_DRAFT_REQUIRED',
      `rate card version "${version}" must be a DRAFT to be published`,
      { version },
    );
  }
  // A published snapshot must be a valid engine rate card.
  mapRowOrThrow(row);

  const effectiveFrom =
    input.effectiveFrom !== undefined
      ? requireIsoDate(input.effectiveFrom, 'effectiveFrom')
      : row.effectiveFrom
        ? new Date(row.effectiveFrom)
        : null;
  const effectiveTo =
    input.effectiveTo !== undefined
      ? requireIsoDate(input.effectiveTo, 'effectiveTo')
      : row.effectiveTo
        ? new Date(row.effectiveTo)
        : null;
  if (effectiveFrom === null) {
    throw adminError(
      'RATE_CARD_ADMIN_INVALID_WINDOW',
      'publish requires an effectiveFrom (request body or draft window)',
      { version },
    );
  }
  if (effectiveTo !== null && effectiveTo.getTime() < effectiveFrom.getTime()) {
    throw adminError('RATE_CARD_ADMIN_INVALID_WINDOW', 'effectiveTo must be >= effectiveFrom', {
      version,
    });
  }

  const outcome = await deps.repository.publish({
    version,
    publishedAt: new Date(),
    effectiveFrom,
    effectiveTo,
    ...(input.replaceActiveVersion !== undefined
      ? { replaceActiveVersion: requireVersion(input.replaceActiveVersion) }
      : {}),
    actorId,
    action: AUDIT_ACTIONS.published,
    retireAction: AUDIT_ACTIONS.retired,
  });

  if (outcome.kind === 'not_found') {
    throw adminError('RATE_CARD_ADMIN_NOT_FOUND', `rate card version "${version}" was not found`, {
      version,
    });
  }
  if (outcome.kind === 'not_draft') {
    throw adminError(
      'RATE_CARD_ADMIN_DRAFT_REQUIRED',
      `rate card version "${version}" must be a DRAFT to be published`,
      { version },
    );
  }
  if (outcome.kind === 'overlap') {
    throw adminError(
      'RATE_CARD_ADMIN_PUBLISH_CONFLICT',
      `rate card version "${version}" overlaps ${outcome.snapshotCount} ACTIVE snapshot(s)`,
      {
        version,
        snapshotCount: outcome.snapshotCount,
        conflictingVersions: outcome.conflictingVersions,
      },
    );
  }
  if (outcome.kind === 'replacement_mismatch') {
    const reason =
      outcome.snapshotCount === 0
        ? 'no ACTIVE snapshot overlaps the new window'
        : outcome.snapshotCount > 1
          ? 'multiple ACTIVE snapshots overlap the new window'
          : 'the new window must start after the replaced snapshot';
    throw adminError(
      'RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH',
      `rate card version "${version}" cannot replace "${outcome.expectedVersion}": ${reason}`,
      {
        version,
        conflictingVersions: outcome.conflictingVersions,
        snapshotCount: outcome.snapshotCount,
      },
    );
  }
  if (outcome.kind === 'candidate_invalid') {
    throw adminError(
      'RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE',
      `rate card snapshot "${version}" could not be published: ${outcome.reason}`,
      { version, mapperCode: outcome.mapperCode },
    );
  }
  if (outcome.kind === 'concurrent') {
    throw adminError(
      'RATE_CARD_ADMIN_PUBLISH_CONFLICT',
      `rate card version "${version}" could not be published because another snapshot was published concurrently`,
      { version },
    );
  }
  return { ...metadataFromRow(outcome.snapshot), idempotentReplay: false };
}

/**
 * Retire an ACTIVE snapshot (transactional ACTIVE → RETIRED). An optional
 * `effectiveTo` (canonical `YYYY-MM-DD`) closes the snapshot's business
 * window in the same write; it must not be before `effectiveFrom` and must
 * never widen an already-closed persisted window.
 *
 * Idempotent replay: retiring an already-RETIRED snapshot whose persisted
 * `retiredAt`/`effectiveTo` match any values supplied in the request is a
 * coherent no-op that returns the existing snapshot with
 * `idempotentReplay: true` (proving timestamps and entries are unchanged —
 * no write occurs). Any conflicting replay, or a retire of a DRAFT, is
 * rejected with `RATE_CARD_ADMIN_ACTIVE_REQUIRED`.
 */
export async function retireRateCard(
  deps: ProviderRateCardAdminDependencies,
  input: AdminRetireInput,
  actorId: string,
): Promise<ProviderRateCardSnapshotMetadata> {
  const version = requireVersion(input.version);
  const row = await deps.repository.findSnapshotByVersion(version);
  if (row === null) {
    throw adminError('RATE_CARD_ADMIN_NOT_FOUND', `rate card version "${version}" was not found`, {
      version,
    });
  }
  if (row.status === 'RETIRED') {
    const effectiveTo =
      input.effectiveTo !== undefined ? requireIsoDate(input.effectiveTo, 'effectiveTo') : null;
    const retiredAt = input.retiredAt !== undefined ? requireIsoDateTime(input.retiredAt) : null;
    const storedEffectiveTo = row.effectiveTo ? isoDateOf(row.effectiveTo) : null;
    const storedRetiredAt = row.retiredAt ? row.retiredAt.toISOString() : null;
    const toCoherent = effectiveTo === null || isoDateOf(effectiveTo) === storedEffectiveTo;
    const retiredCoherent = retiredAt === null || retiredAt.toISOString() === storedRetiredAt;
    if (toCoherent && retiredCoherent) {
      return { ...metadataFromRow(row), idempotentReplay: true };
    }
    throw adminError(
      'RATE_CARD_ADMIN_ACTIVE_REQUIRED',
      `rate card version "${version}" must be ACTIVE to be retired`,
      { version },
    );
  }
  if (row.status !== 'ACTIVE') {
    throw adminError(
      'RATE_CARD_ADMIN_ACTIVE_REQUIRED',
      `rate card version "${version}" must be ACTIVE to be retired`,
      { version },
    );
  }
  const retiredAt = requireIsoDateTime(input.retiredAt);
  if (row.publishedAt !== null && retiredAt.getTime() < row.publishedAt.getTime()) {
    throw adminError(
      'RATE_CARD_ADMIN_INVALID_WINDOW',
      'retiredAt must be >= publishedAt',
      { version },
    );
  }

  let effectiveTo: Date | undefined;
  if (input.effectiveTo !== undefined) {
    const parsed = requireIsoDate(input.effectiveTo, 'effectiveTo');
    if (row.effectiveFrom === null) {
      throw adminError(
        'RATE_CARD_ADMIN_INVALID_WINDOW',
        'effectiveTo requires an effectiveFrom',
        { version },
      );
    }
    if (parsed.getTime() < row.effectiveFrom.getTime()) {
      throw adminError(
        'RATE_CARD_ADMIN_INVALID_WINDOW',
        'effectiveTo must be >= effectiveFrom',
        { version },
      );
    }
    if (row.effectiveTo !== null && parsed.getTime() > row.effectiveTo.getTime()) {
      throw adminError(
        'RATE_CARD_ADMIN_INVALID_WINDOW',
        'effectiveTo must not widen the persisted window',
        { version },
      );
    }
    effectiveTo = parsed;
  }

  const outcome = await deps.repository.retire({
    version,
    retiredAt,
    ...(effectiveTo !== undefined ? { effectiveTo } : {}),
    actorId,
    action: AUDIT_ACTIONS.retired,
  });

  if (outcome.kind === 'not_found') {
    throw adminError('RATE_CARD_ADMIN_NOT_FOUND', `rate card version "${version}" was not found`, {
      version,
    });
  }
  if (outcome.kind === 'not_active') {
    throw adminError(
      'RATE_CARD_ADMIN_ACTIVE_REQUIRED',
      `rate card version "${version}" must be ACTIVE to be retired`,
      { version },
    );
  }
  return { ...metadataFromRow(outcome.snapshot), idempotentReplay: false };
}

/**
 * Clone an existing snapshot into a brand-new DRAFT (the "Update Prices" flow).
 *
 * The repository performs the whole clone — target snapshot creation plus the
 * verbatim copy of every source pricing entry — inside ONE database
 * transaction, so a failed copy rolls the target back completely and leaves no
 * DRAFT behind. Only an ACTIVE source may be cloned: DRAFT and RETIRED sources
 * are rejected with RATE_CARD_ADMIN_ACTIVE_REQUIRED. The source is never
 * modified and never retired, and its ACTIVE/RETIRED lifecycle state (status,
 * publishedAt, retiredAt, business window) is never copied — while its pricing
 * metadata (schemaVersion, currency, storageUnit, engineUnit, provenance) IS
 * preserved — so the clone is always a fresh DRAFT with a null window, ready
 * for the admin to edit, validate, and publish through the existing workflow.
 */
export async function cloneRateCard(
  deps: ProviderRateCardAdminDependencies,
  input: AdminCloneInput,
  actorId: string,
): Promise<ProviderRateCardSnapshotMetadata> {
  const sourceVersion = requireVersion(input.sourceVersion);
  const newVersion = requireVersion(input.newVersion);
  if (sourceVersion === newVersion) {
    throw adminError(
      'RATE_CARD_ADMIN_INVALID_PAYLOAD',
      'newVersion must differ from the source version',
      { version: newVersion },
    );
  }
  const outcome = await deps.repository.cloneSnapshot({
    sourceVersion,
    newVersion,
    actorId,
    action: AUDIT_ACTIONS.draftCloned,
  });
  if (outcome.kind === 'source_not_found') {
    throw adminError(
      'RATE_CARD_ADMIN_NOT_FOUND',
      `rate card version "${sourceVersion}" was not found`,
      { version: sourceVersion },
    );
  }
  if (outcome.kind === 'source_not_active') {
    throw adminError(
      'RATE_CARD_ADMIN_ACTIVE_REQUIRED',
      `rate card version "${sourceVersion}" must be ACTIVE to be cloned`,
      { version: sourceVersion },
    );
  }
  if (outcome.kind === 'target_version_taken') {
    throw adminError(
      'RATE_CARD_ADMIN_VERSION_TAKEN',
      `rate card version "${newVersion}" already exists`,
      { version: newVersion },
    );
  }
  return metadataFromRow(outcome.snapshot);
}

/** List snapshots (pagination + optional lifecycle status filter). */
export async function listRateCardSnapshots(
  deps: ProviderRateCardAdminDependencies,
  query: AdminRateCardListQuery,
): Promise<AdminRateCardListResult> {
  const repoQuery: AdminListQuery = {
    page: query.page,
    limit: query.limit,
    ...(query.status !== undefined ? { status: query.status } : {}),
  };
  return toListResult(await deps.repository.list(repoQuery));
}

/** Load one snapshot by immutable version with its engine-domain entries. */
export async function getRateCardByVersion(
  deps: ProviderRateCardAdminDependencies,
  version: string,
): Promise<AdminRateCardSnapshotDetail> {
  const normalized = requireVersion(version);
  const row = await deps.repository.findSnapshotByVersion(normalized);
  if (row === null) {
    throw adminError('RATE_CARD_ADMIN_NOT_FOUND', `rate card version "${normalized}" was not found`, {
      version: normalized,
    });
  }
  const base = metadataFromRow(row);
  try {
    const mapped = mapProviderRateCardSnapshot(row);
    return {
      ...base,
      entries: mapped.card.entries,
      providers: mapped.providers,
      mappingError: null,
    };
  } catch (error) {
    const code =
      error instanceof ProviderRateCardSnapshotError
        ? error.code
        : 'SNAPSHOT_INVALID';
    return {
      ...base,
      entries: [],
      providers: [],
      mappingError: { code, message: String((error as Error).message) },
    };
  }
}

/**
 * Import the static `PROVIDER_RATE_CARD` as a DRAFT snapshot only. The static
 * card remains the only runtime pricing source; nothing here ever activates a
 * static-card snapshot. The persisted version is the EXACT
 * `PROVIDER_RATE_CARD.version` (no `static-` prefix) unless an explicit
 * `version` is supplied.
 *
 * Idempotency: importing the static card under a version that already exists
 *  - returns `{ idempotentReplay: true }` WITHOUT any write when the existing
 *    snapshot is a DRAFT that semantically equals the static card;
 *  - raises `RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT` when the existing DRAFT
 *    carries different content (never silently overwritten);
 *  - raises `RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT` when the version is
 *    already ACTIVE/RETIRED (published snapshots are never touched).
 */
export async function importStaticRateCardAsDraft(
  deps: ProviderRateCardAdminDependencies,
  input: AdminStaticImportInput,
  actorId: string,
): Promise<ProviderRateCardSnapshotMetadata> {
  const version =
    input.version !== undefined && input.version.trim().length > 0
      ? requireVersion(input.version)
      : PROVIDER_RATE_CARD.version;
  const source = PROVIDER_RATE_CARD.source;
  const generatedAt = requireIsoDate(PROVIDER_RATE_CARD.generatedAt, 'generatedAt');

  const existing = await deps.repository.findSnapshotByVersion(version);
  if (existing !== null) {
    if (existing.status !== 'DRAFT') {
      throw adminError(
        'RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT',
        `static rate card version "${version}" already exists as ${existing.status} and an import never overwrites a published snapshot`,
        { version },
      );
    }
    const expected = buildExpectedStaticSnapshotRow(version, source, generatedAt);
    if (semanticParityEqual(existing, expected)) {
      return { ...metadataFromRow(existing), idempotentReplay: true };
    }
    throw adminError(
      'RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT',
      `static rate card version "${version}" already exists as a DRAFT with different content`,
      { version },
    );
  }

  await deps.repository.createDraft({
    version,
    source,
    generatedAt,
    effectiveFrom: null,
    effectiveTo: null,
    actorId,
    action: AUDIT_ACTIONS.staticImported,
  });

  const { rows } = convertImport({
    version,
    source,
    generatedAt: PROVIDER_RATE_CARD.generatedAt,
    entries: PROVIDER_RATE_CARD.entries,
  });

  const outcome = await deps.repository.importEntries({
    version,
    rows,
    source,
    generatedAt,
    actorId,
    action: AUDIT_ACTIONS.entriesImported,
  });

  if (outcome.kind !== 'imported') {
    throw adminError(
      'RATE_CARD_ADMIN_DATABASE_ERROR',
      `static rate card import into draft "${version}" did not complete`,
      { version },
    );
  }
  return { ...metadataFromRow(outcome.snapshot), idempotentReplay: false };
}

export { PROVIDER_RATE_CARD, RATE_CARD_PROVIDERS };
