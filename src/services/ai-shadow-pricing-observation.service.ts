/**
 * Phase 2D-A bounded in-memory shadow-pricing observation buffer.
 *
 * A per-process ring buffer that stores the most recent immutable shadow
 * observations. It is intentionally trivial and dependency-free:
 *
 *  - fixed internal maximum capacity (`DEFAULT_OBSERVATION_CAPACITY = 500`)
 *  - no environment variable, no database, no Prisma
 *  - oldest observation is removed when capacity is exceeded
 *  - consumers receive deep-cloned immutable snapshots (never internal arrays)
 *  - `reset()` is a deterministic test/process seam
 *
 * Observations hold only reportable (JSON-safe) data: the reportable shadow
 * result plus source/conversationId/observedAt. No raw prompts, AI responses,
 * provider payloads, or secrets are ever stored.
 *
 * Coverage counters are intentionally NOT maintained here; Phase 2D-B will
 * derive metrics from the immutable snapshots.
 */

import type { ReportableShadow } from '../utils/provider-pricing/reporting.js';

/** Fixed per-process default capacity for the ring buffer. */
export const DEFAULT_OBSERVATION_CAPACITY = 500;

/** A single immutable shadow-pricing observation for a request. */
export interface ShadowPricingObservation {
  observedAt: string;
  source: string;
  conversationId?: string | null;
  /** The full reportable shadow result (JSON-safe; no bigint). */
  report: ReportableShadow;
}

export interface AiShadowPricingObservationServiceOptions {
  /** Maximum observations retained. Defaults to {@link DEFAULT_OBSERVATION_CAPACITY}. */
  capacity?: number;
}

/**
 * Bounded per-process ring buffer of shadow-pricing observations.
 */
export class AiShadowPricingObservationService {
  private readonly capacity: number;
  private readonly buffer: ShadowPricingObservation[] = [];

  constructor(options?: AiShadowPricingObservationServiceOptions) {
    const cap = options?.capacity ?? DEFAULT_OBSERVATION_CAPACITY;
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new RangeError('observation capacity must be a positive integer');
    }
    this.capacity = cap;
  }

  get maxCapacity(): number {
    return this.capacity;
  }

  /**
   * Append one observation; the caller's reference is deep-cloned so subsequent
   * caller-side mutation cannot affect internal state. Drops the oldest when
   * at capacity.
   */
  record(observation: ShadowPricingObservation): void {
    this.buffer.push(structuredClone(observation) as ShadowPricingObservation);
    while (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
  }

  /** Current number of retained observations. */
  size(): number {
    return this.buffer.length;
  }

  /**
   * Immutable snapshot of the retained observations, oldest-first. The returned
   * deep clone cannot mutate internal buffer state.
   */
  snapshot(): ShadowPricingObservation[] {
    return this.buffer.slice().map((o) => structuredClone(o)) as ShadowPricingObservation[];
  }

  /** Deterministic reset for tests / process lifecycle. */
  reset(): void {
    this.buffer.length = 0;
  }
}