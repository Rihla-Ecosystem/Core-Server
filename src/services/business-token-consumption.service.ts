import { TokenTransactionSource } from '@prisma/client';

/**
 * Legacy fixed-deduction consumption contracts.
 *
 * Phase 2G-B removed the legacy FIXED billing mode: the live billing path is
 * usage-based only, so the fixed-cost `consume`/`reverse` token functions were
 * removed. This module retains only the source-domain contract that the
 * usage-based coordinator and reservation layer still depend on
 * (`BusinessConsumptionSource` + `isBusinessConsumptionSource`).
 */

export type BusinessConsumptionSource = Exclude<
  TokenTransactionSource,
  'PURCHASE' | 'ADMIN'
>;

const ALL_TRANSACTION_SOURCES: readonly string[] = Object.values(TokenTransactionSource);
const BUSINESS_EXCLUDED_SOURCES: readonly string[] = ['PURCHASE', 'ADMIN'];

export function isBusinessConsumptionSource(
  value: string,
): value is BusinessConsumptionSource {
  return (
    ALL_TRANSACTION_SOURCES.includes(value) &&
    !BUSINESS_EXCLUDED_SOURCES.includes(value)
  );
}
