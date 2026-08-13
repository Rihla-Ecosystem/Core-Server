# Phase 8A — Refund Eligibility Audit

## Executive Conclusion

This document presents the Phase 8A read-only audit of refund eligibility and purchase token traceability across **Core Server** (`Core-Server-main`).

### Confirmed Business Rule
> **A purchased Token Package can be refunded ONLY if ZERO Wallet Points from that specific purchase have been consumed.**
> **If ANY Wallet Points belonging to that purchase have been consumed, REFUND MUST NOT BE ALLOWED.**

### Audit Finding Summary
The current database schema provides **PARTIAL TRACEABILITY**:
- **Purchase credit** is fully traceable back to its `Payment` via `TokenTransaction` (`type: 'GRANT'`, `source: 'PURCHASE'`, `paymentId`).
- **Consumption** is **NOT** allocated back to specific purchases because `TokenWallet.tokenBalance` is a single fungible integer pool, and `TokenTransaction` (`type: 'CONSUME'`) records `paymentId: null` without lot or grant references.

Consequently, **the current schema CANNOT determine whether 0 points from a specific purchase have been consumed in mixed-balance, multi-purchase, or post-grant scenarios.** Simple balance checks (`tokenBalance >= package.tokens`) are **UNSAFE** and lead to false refund approvals.

---

## Current Purchase Credit Trace

When a user completes a Token Package purchase via Paymob:

1. `POST /payments/intention` creates a `Payment` record in `PENDING` status with snapshots of `packageNameSnapshot`, `tokensSnapshot`, `priceSnapshot`, `currencySnapshot`.
2. Paymob success webhook (`paymob-webhook.service.ts` line 381) executes an atomic DB transaction:
   - Claims `Payment.status`: `PENDING` -> `COMPLETED`.
   - Increments `TokenWallet.tokenBalance` by `tokensSnapshot`.
   - Creates a `TokenTransaction` with:
     - `type`: `'GRANT'`
     - `source`: `'PURCHASE'`
     - `tokens`: `payment.tokensSnapshot` (e.g. 1000)
     - `paymentId`: `payment.id` (Linked directly to `Payment`)
     - `referenceId`: Paymob `transactionId`
     - `metadata`: `{ paymentId, tokenPackageId, packageNameSnapshot }`

### Purchase Identification Verdict
**YES.** We can reliably identify the exact `TokenTransaction` and token amount credited by a specific `Payment` (`TokenTransaction.paymentId = payment.id`).

---

## Current Consumption Trace

When a user executes a billed AI operation (Chat, Image, Voice, Itinerary):

1. **Reservation Phase**: `token-reservation.service.ts` decrements `TokenWallet.tokenBalance` and increments `TokenWallet.reservedBalance`. Creates `TokenReservation` in `PENDING` status.
2. **Settlement Phase**: `settleBusinessTokenReservationForAmount` decrements `reservedBalance` by the reserved amount, restores unused points to `tokenBalance`, and creates a `TokenTransaction`:
   - `type`: `'CONSUME'`
   - `source`: `'CHAT'` (or `'IMAGE'`, `'VOICE'`, `'ITINERARY'`)
   - `tokens`: `actualTokens` (e.g. 50)
   - `paymentId`: **`null`**
   - `referenceId`: `${reservation.referenceId}:settle`
   - `metadata`: `{ reservationId, actualTokens, releasedTokens, pricingVersion }`

### Consumption Allocation Verdict
**NO.** Consumption transactions do **NOT** record:
- Which purchase or grant supplied the consumed points.
- `paymentId` (it is `null`).
- Purchase lot ID or grant transaction ID.
- FIFO / LIFO allocation records.

---

## Mixed Balance Analysis

### Scenario
- Initial Wallet: 400 signup points (from `grantFirstLoginTokens`).
- Purchase A: Package A (+1000 points via Payment X).
- `TokenWallet.tokenBalance` = 1400.
- User consumes 50 points (`type: CONSUME`, 50 points).
- Current `TokenWallet.tokenBalance` = 1350.

### Analysis
The 50 consumed points were subtracted from the combined 1400 balance. The `CONSUME` transaction records `-50 tokens` for source `CHAT`, but contains no reference to either the signup grant or Package A.

**Conclusion**: The current database state **cannot prove** whether the 50 consumed points came from the free signup grant, Package A, or a mixture of both.

---

## Multiple Purchase Analysis

### Scenario
- Purchase A (Payment 1): +1000 points.
- Purchase B (Payment 2): +2000 points.
- Combined `TokenWallet.tokenBalance` = 3000.
- User consumes 500 points.
- Current `TokenWallet.tokenBalance` = 2500.

### Analysis
Both purchases incremented the single scalar `tokenBalance` integer in `TokenWallet`. Consumption simply decrements `tokenBalance`. There is no lot tracking or ledger linking `CONSUME` transactions to specific `GRANT` transactions.

**Conclusion**: The current system **cannot determine** whether Purchase A was used, Purchase B was used, or both were partially used.

---

## Admin / Bonus / Grant Effect

Points enter `TokenWallet` from four sources:
1. Signup free grant (400 points)
2. Package purchases
3. Admin manual adjustments
4. Bonus credits (enum defined)

Once credited, all points are merged into `TokenWallet.tokenBalance`. The spending engine (`token-reservation.service.ts`) simply checks `tokenBalance >= tokens` and decrements `tokenBalance`.

**Conclusion**: Wallet Points are **100% fungible** after entering `TokenWallet`. Spending does not distinguish between sources.

---

## Reserved Balance Analysis

Suppose a user purchased Package A (+1000 points), has never consumed any points historically (`CONSUME` count = 0), but currently has **100 points inside `reservedBalance`** for an active/pending AI request:
- `tokenBalance` = 900
- `reservedBalance` = 100
- Total Wallet Balance = 1000

### Refund Safety Verdict
**UNSAFE TO REFUND.**
1. The 100 reserved points are actively locked for a pending AI operation. If that AI operation settles, 50 points will be consumed, meaning Package A points WILL have been consumed.
2. If Package A (1000 points) is refunded while 100 points are reserved, deducting 1000 points from `tokenBalance` (900) will push `tokenBalance` negative (-100) or fail the atomic balance constraint.

**Requirement**: Refund eligibility **must check** active `reservedBalance`, `PENDING` reservations, `REVIEW_REQUIRED` operations, and `PRICED` operations awaiting settlement.

---

## Current Paymob Refund Event Behavior

Inspecting `paymob-webhook.service.ts` lines 350–353:
```ts
// 5. Handle Refund / Void flags
if (data.isRefunded || data.isVoided) {
  // Safely acknowledge; refund/void handling is out of scope for this phase
  return;
}
```

1. **Webhook Behavior**: Returns `200 OK` without performing any database updates.
2. **Payment Status**: Unchanged (remains `COMPLETED`).
3. **Wallet Balance**: Unchanged.
4. **TokenTransaction REFUND**: **NOT created**.
5. **Duplicate Protection**: N/A (currently no-op).
6. **Partial Refunds**: Unhandled.
7. **Payment Identification**: Paymob sends `order.merchant_order_id`, which reliably contains internal `Payment.id`.

---

## Traceability Classification

The current system is classified as:

### **CATEGORY B — PARTIAL TRACEABILITY**

> **Reason**: Purchase credit can be reliably identified via `TokenTransaction.paymentId`, but later consumption cannot be allocated back to individual purchases because `TokenWallet.tokenBalance` is a single fungible scalar integer and `CONSUME` transactions do not record grant or lot references.

---

## Why Simple Balance Checking Is Unsafe

Using `wallet.tokenBalance >= package.tokens` to check refund eligibility is **FLAWED and UNSAFE**:

1. **False Approvals via Signup Grants**: A user receives 400 signup points, buys 1000 points (Package A), total = 1400. User consumes 400 points (balance = 1000). A simple check `1000 >= 1000` falsely approves refund even though 400 points were consumed!
2. **False Approvals via Admin Credits**: A user buys Package A (1000 points), consumes 500 points (balance = 500). Admin grants 500 points. Balance = 1000. Simple check `1000 >= 1000` falsely approves refund even though 500 package points were consumed!
3. **Ambiguity with Multiple Purchases**: User buys Package A (1000) and Package B (2000), total = 3000. User consumes 500 points (balance = 2500). Simple check `2500 >= 1000` approves Package A refund, even though 500 points were consumed from the wallet!
4. **Reserved Balance Races**: If 100 points are in `reservedBalance`, a total balance check ignores the pending consumption risk.

---

## Minimal Design Options (For Phase 8B)

*(DO NOT IMPLEMENT IN PHASE 8A — FOR DESIGN REVIEW ONLY)*

### Option 1: Purchase Lot Model (`TokenPurchaseLot`) *(RECOMMENDED)*
- **Schema**: Add `TokenPurchaseLot` model:
  - `id`: UUID
  - `paymentId`: UUID (unique)
  - `userId`: UUID
  - `grantedTokens`: Int
  - `remainingTokens`: Int
  - `status`: Enum (`ACTIVE`, `EXHAUSTED`, `REFUNDED`)
- **Consumption Path**: `settleBusinessTokenReservationForAmount` consumes tokens from the oldest active `TokenPurchaseLot` (FIFO order), decrementing `remainingTokens`.
- **Refund Check**: `lot.remainingTokens === lot.grantedTokens` AND `reservedBalance === 0`.
- **Complexity**: Low-Medium (atomic decrement alongside wallet balance).
- **Accuracy**: 100% exact.

### Option 2: Consumption Allocation Ledger (`TokenConsumptionAllocation`)
- **Schema**: Add junction model `TokenConsumptionAllocation(consumeTransactionId, grantTransactionId, tokens)`.
- **Consumption Path**: Settle logic allocates consumed tokens against available `GRANT` transactions in FIFO order.
- **Refund Check**: `SUM(allocations for Payment X) === 0`.
- **Complexity**: Medium.
- **Accuracy**: 100% exact.

---

## Critical Questions Verified

| Question | Answer | Reason / Evidence |
| :--- | :---: | :--- |
| **1. Can total Wallet balance alone prove a package is unused?** | **NO** | Signup grants, admin credits, and multiple purchases pollute scalar `tokenBalance`. |
| **2. Can current `TokenTransaction` history prove a package is unused?** | **NO** | `CONSUME` transactions do not link to `paymentId` or grant transaction IDs. |
| **3. Can current `TokenReservation` history prove it?** | **NO** | Reservations decrement generic wallet balance without lot association. |
| **4. Is `tokenBalance >= package.tokens` sufficient for refund eligibility?** | **NO** | Highly unsafe; leads to false refund approvals. |
| **5. Can an admin credit make that balance check falsely approve a refund?** | **YES** | Admin credits inflate `tokenBalance` above package token threshold. |
| **6. Can signup grant make that balance check falsely approve a refund?** | **YES** | 400 signup points inflate `tokenBalance` after partial consumption. |
| **7. Can purchasing multiple packages make that balance check ambiguous?** | **YES** | Interleaved purchases merge into single balance pool. |
| **8. Can a PENDING reservation make a supposedly unused package unsafe to refund?** | **YES** | Pending reservations may settle after refund, causing negative balance or unbilled usage. |

---

## Next Steps
Proceed to **Phase 8B** to specify the exact implementation design (Option 1 `TokenPurchaseLot` model) before writing code.
