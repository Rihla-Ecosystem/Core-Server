{
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Safety check failed: DATABASE_URL is not set');
  const pathname = new URL(dbUrl).pathname;
  if (!['/core_server_test', '/core_server_test_suite'].includes(pathname)) {
    throw new Error(
      `Safety check failed: DATABASE_URL must be an approved isolated test database, got "${pathname}"`,
    );
  }
}

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Gender,
  PaymentStatus,
  TokenTransactionSource,
  TokenTransactionType,
  WalletStatus,
} from '@prisma/client';
import app from '../src/app.js';
import { prisma } from '../src/config/prisma.js';
import { MAX_TOKEN_BALANCE } from '../src/config/business-token-features.js';
import { processPaymobWebhook } from '../src/services/paymob-webhook.service.js';
import { ensureUserRole } from './helpers/test-role-fixtures.js';

// ---------------------------------------------------------------------------
// Independent HMAC test helper (NOT the production verifier).
//
// Reconstructs the canonical Paymob SHA-512 signature from the documented
// 20-field ordered concatenation directly with node:crypto, so the test never
// verifies production code against itself (no tautology).
// ---------------------------------------------------------------------------
const TEST_HMAC_SECRET = process.env.PAYMOB_HMAC_SECRET || 'paymob_hmac_secret_here';
const TEST_INTEGRATION_ID = Number(process.env.PAYMOB_CARD_INTEGRATION_ID) || 123456;

function signHmac(obj: Record<string, unknown>): string {
  const od = obj.order as Record<string, unknown>;
  const sd = obj.source_data as Record<string, unknown>;
  const fields = [
    obj.amount_cents,
    obj.created_at,
    obj.currency,
    obj.error_occured,
    obj.has_parent_transaction,
    obj.id,
    obj.integration_id,
    obj.is_3d_secure,
    obj.is_auth,
    obj.is_capture,
    obj.is_refunded,
    obj.is_standalone_payment,
    obj.is_voided,
    od.id,
    obj.owner,
    obj.pending,
    sd.pan,
    sd.sub_type,
    sd.type,
    obj.success,
  ];
  const concatenated = fields.map((v) => String(v)).join('');
  return crypto
    .createHmac('sha512', TEST_HMAC_SECRET)
    .update(concatenated)
    .digest('hex')
    .toLowerCase();
}

const NAMESPACE = 'p2a_paymob_';
function nsEmail(suffix = crypto.randomUUID()) {
  return `${NAMESPACE}${suffix}@example.com`;
}
function nsCode(suffix = crypto.randomUUID()) {
  return `${NAMESPACE}${suffix}`;
}

interface PaymobObj {
  amount_cents: number;
  created_at: string;
  currency: string;
  error_occured: boolean;
  has_parent_transaction: boolean;
  id: number | string;
  integration_id: number;
  is_3d_secure: boolean;
  is_auth: boolean;
  is_capture: boolean;
  is_refunded: boolean;
  is_standalone_payment: boolean;
  is_voided: boolean;
  pending: boolean;
  success: boolean;
  order: {
    id: number | string;
    merchant_order_id: string;
  };
  owner: number | string;
  source_data: { pan: string; sub_type: string; type: string };
}

interface PaymobBody {
  type: 'TRANSACTION';
  obj: PaymobObj;
}

function buildObj(overrides: Partial<Record<keyof PaymobObj, unknown>> & { order?: Partial<PaymobObj['order']>; source_data?: Partial<PaymobObj['source_data']> } = {}): PaymobObj {
  const obj: PaymobObj = {
    amount_cents: 1000,
    created_at: '2026-08-15T12:00:00.000Z',
    currency: 'EGP',
    error_occured: false,
    has_parent_transaction: false,
    id: crypto.randomUUID(),
    integration_id: TEST_INTEGRATION_ID,
    is_3d_secure: true,
    is_auth: false,
    is_capture: true,
    is_refunded: false,
    is_standalone_payment: false,
    is_voided: false,
    pending: false,
    success: true,
    order: {
      id: 1_000_000,
      merchant_order_id: crypto.randomUUID(),
    },
    owner: '1234',
    source_data: { pan: '529741**********1234', sub_type: 'MasterCard', type: 'card' },
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (k === 'order' || k === 'source_data') continue;
    (obj as Record<string, unknown>)[k] = v;
  }
  if (overrides.order) Object.assign(obj.order, overrides.order);
  if (overrides.source_data) Object.assign(obj.source_data, overrides.source_data);
  return obj;
}

function signedPayload(obj: PaymobObj): { body: PaymobBody; hmac: string } {
  const body: PaymobBody = { type: 'TRANSACTION', obj };
  return { body, hmac: signHmac(obj) };
}

// ---------------------------------------------------------------------------
// Shared fixture tracking for FK-safe cleanup of ONLY this suite's rows.
// ---------------------------------------------------------------------------
const createdUserIds: string[] = [];
const createdPackageIds: number[] = [];
const createdPaymentIds: string[] = [];
const createdWalletIds: string[] = [];

let roleId: number;

async function createUser() {
  const user = await prisma.user.create({
    data: {
      roleId,
      email: nsEmail(),
      passwordHash: 'hash',
      displayName: 'P2A Paymob Test User',
      gender: Gender.MALE,
      nationality: 'Egyptian',
      isEmailVerified: true,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

async function createPackage(opts: { price: string; tokens: number; currency?: string } = { price: '10.00', tokens: 100, currency: 'EGP' }) {
  const pkg = await prisma.tokenPackage.create({
    data: {
      name: nsCode('pkg'),
      code: nsCode(),
      price: opts.price,
      currency: opts.currency ?? 'EGP',
      tokens: opts.tokens,
      isActive: true,
    },
  });
  createdPackageIds.push(pkg.id);
  return pkg;
}

async function createPayment(userId: string, pkg: { id: number; name: string; price: string; tokens: number; currency: string }, status: PaymentStatus = PaymentStatus.PENDING, providerTransactionId: string | null = null) {
  const payment = await prisma.payment.create({
    data: {
      userId,
      tokenPackageId: pkg.id,
      amount: pkg.price,
      currency: pkg.currency,
      status,
      packageNameSnapshot: pkg.name,
      tokensSnapshot: pkg.tokens,
      priceSnapshot: pkg.price,
      currencySnapshot: pkg.currency,
      provider: 'PAYMOB',
      ...(providerTransactionId ? { providerTransactionId } : {}),
    },
  });
  createdPaymentIds.push(payment.id);
  return payment;
}

async function createWallet(userId: string, tokenBalance: number, status: WalletStatus = WalletStatus.ACTIVE) {
  const wallet = await prisma.tokenWallet.create({ data: { userId, tokenBalance, status } });
  createdWalletIds.push(wallet.id);
  return wallet;
}

async function cleanupSuiteData(): Promise<void> {
  if (createdUserIds.length === 0 && createdPackageIds.length === 0) return;
  await prisma.auditLog.deleteMany({ where: { targetUserId: { in: createdUserIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
  await prisma.tokenReservationFundingAllocation.deleteMany({
    where: { fundingLot: { userId: { in: createdUserIds } } },
  });
  await prisma.tokenReservationFundingAllocation.deleteMany({
    where: { reservation: { user: { id: { in: createdUserIds } } } },
  });
  await prisma.tokenFundingLot.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: createdPaymentIds } } });
  await prisma.tokenTransaction.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
  await prisma.tokenWallet.deleteMany({ where: { id: { in: createdWalletIds } } });
  await prisma.tokenWallet.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.tokenPackage.deleteMany({ where: { id: { in: createdPackageIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  createdUserIds.length = 0;
  createdPackageIds.length = 0;
  createdPaymentIds.length = 0;
  createdWalletIds.length = 0;
}

async function fundingLotCountFor(userId: string): Promise<number> {
  return prisma.tokenFundingLot.count({ where: { userId } });
}
async function purchaseTxCountFor(userId: string): Promise<number> {
  return prisma.tokenTransaction.count({ where: { userId, source: 'PURCHASE' } });
}

// ---------------------------------------------------------------------------
describe('Paymob Money-In Critical Test Hardening (Phase P2A)', () => {
  let server: Server;
  let baseUrl = '';

  before(async () => {
    await cleanupSuiteData();
    roleId = (await ensureUserRole()).id;
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  after(async () => {
    try {
      await cleanupSuiteData();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await prisma.$disconnect();
    }
  });

  async function postWebhook(body: PaymobBody, hmac: string) {
    const res = await fetch(`${baseUrl}/api/payments/paymob/webhook?hmac=${encodeURIComponent(hmac)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json as { success?: boolean; error?: string } | null };
  }

  async function makePendingPurchase(opts: { balance?: number; walletStatus?: WalletStatus; walletExists?: boolean } = {}) {
    const user = await createUser();
    const pkg = await createPackage({ price: '10.00', tokens: 100, currency: 'EGP' });
    const payment = await createPayment(user.id, pkg);
    let wallet: Awaited<ReturnType<typeof createWallet>> | null = null;
    if (opts.walletExists !== false) {
      wallet = await createWallet(user.id, opts.balance ?? 0, opts.walletStatus ?? WalletStatus.ACTIVE);
    }
    return { user, pkg, payment, wallet };
  }

  /* ================= GROUP A — AUTHENTICITY ================= */

  test('A1. Valid HMAC + valid payload is accepted (HTTP 200)', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id } }));
    const res = await postWebhook(body, hmac);
    assert.equal(res.status, 200);
    assert.equal(res.body?.success, true);
    const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(dbPayment?.status, PaymentStatus.COMPLETED);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 100);
    assert.equal(await purchaseTxCountFor(payment.userId), 1);
    assert.equal(await fundingLotCountFor(payment.userId), 1);
  });

  test('A2. Missing HMAC is rejected, no Payment mutation, no credit', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body } = signedPayload(buildObj({ order: { merchant_order_id: payment.id } }));
    const res = await postWebhook(body, '');
    assert.equal(res.status, 403);
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.PENDING);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
    assert.equal(await fundingLotCountFor(payment.userId), 0);
  });

  test('A3. Invalid HMAC is rejected, no Payment mutation, no credit', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body } = signedPayload(buildObj({ order: { merchant_order_id: payment.id } }));
    const res = await postWebhook(body, 'a'.repeat(128));
    assert.equal(res.status, 403);
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.PENDING);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
  });

  test('A4. Wrong-length / malformed hex HMAC is rejected safely without crash or credit', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body } = signedPayload(buildObj({ order: { merchant_order_id: payment.id } }));
    for (const bad of ['', 'zzzz', 'a'.repeat(127), 'a'.repeat(129), 'GHIJ']) {
      const res = await postWebhook(body, bad);
      assert.equal(res.status, 403, `expected 403 for hmac ${JSON.stringify(bad)}`);
    }
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.PENDING);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
  });

  test('A5. Payload changed after signature generation is rejected, no credit', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const original = buildObj({ order: { merchant_order_id: payment.id } });
    const { hmac } = signedPayload(original);
    // Tamper with the amount AFTER computing the signature (but keep valid structure)
    const tampered = buildObj({ order: { merchant_order_id: payment.id }, amount_cents: 2000 });
    const res = await postWebhook(tampered, hmac);
    assert.equal(res.status, 403);
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.PENDING);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
  });

  /* ================= GROUP B — FINANCIAL RECONCILIATION ================= */

  test('B1. Correct amount is accepted and credits exactly tokensSnapshot', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id } }));
    assert.equal((await postWebhook(body, hmac)).status, 200);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, payment.tokensSnapshot);
  });

  test('B2. Wrong amount is rejected (409), wallet unchanged', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, amount_cents: 1001 }));
    assert.equal(await postWebhook(body, hmac).then((r) => r.status), 409);
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.PENDING);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
  });

  test('B3. Underpayment (amount_cents too low) is rejected', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, amount_cents: 999 }));
    assert.equal(await postWebhook(body, hmac).then((r) => r.status), 409);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
  });

  test('B4. Overpayment (amount_cents too high) is rejected', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, amount_cents: 2000 }));
    assert.equal(await postWebhook(body, hmac).then((r) => r.status), 409);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
  });

  test('B5. Wrong currency is rejected (409), no credit', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, currency: 'USD' }));
    assert.equal(await postWebhook(body, hmac).then((r) => r.status), 409);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
  });

  test('B6. Wrong integration id is rejected (409), no credit', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, integration_id: TEST_INTEGRATION_ID + 1 }));
    assert.equal(await postWebhook(body, hmac).then((r) => r.status), 409);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
  });

  test('B7. Unknown merchant/payment id is a safe no-credit ack (200)', async () => {
    const { user, pkg } = await makePendingPurchase();
    const unknownPaymentId = crypto.randomUUID();
    // seed a wallet to prove it is untouched
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: unknownPaymentId } }));
    const res = await postWebhook(body, hmac);
    assert.equal(res.status, 200);
    assert.equal(res.body?.success, true);
    assert.equal(await prisma.payment.count({ where: { id: unknownPaymentId } }), 0);
    assert.equal(await purchaseTxCountFor(user.id), 0);
    assert.equal(await fundingLotCountFor(user.id), 0);
    void pkg;
  });

  test('B8. Malformed merchant_order_id (non-UUID) is rejected safely (400)', async () => {
    const { user } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: 'not-a-uuid' } }));
    const res = await postWebhook(body, hmac);
    assert.equal(res.status, 400);
    assert.equal(await purchaseTxCountFor(user.id), 0);
  });

  /* ================= GROUP C — SUCCESSFUL CREDIT ================= */

  test('C1-C10. Successful credit produces a coherent full ledger', async () => {
    const { payment, wallet, pkg } = await makePendingPurchase({ balance: 50 });
    const txId = 'paymob-tx-' + crypto.randomUUID();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, id: txId }));
    assert.equal((await postWebhook(body, hmac)).status, 200);

    const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    const dbWallet = await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } });
    const txs = await prisma.tokenTransaction.findMany({ where: { userId: payment.userId } });
    const lots = await prisma.tokenFundingLot.findMany({ where: { userId: payment.userId } });

    assert.equal(dbPayment?.status, PaymentStatus.COMPLETED); // C1
    assert.equal(dbWallet?.tokenBalance, 50 + payment.tokensSnapshot); // C2
    assert.equal(txs.length, 1); // C3
    assert.equal(txs[0].type, TokenTransactionType.GRANT);
    assert.equal(txs[0].source, TokenTransactionSource.PURCHASE);
    assert.equal(txs[0].referenceId, txId); // C4
    assert.equal(lots.length, 1); // C5
    assert.equal(lots[0].source, 'PURCHASE'); // C5
    assert.equal(lots[0].paymentId, payment.id); // C6
    assert.equal(lots[0].originalTokens, payment.tokensSnapshot); // C7
    assert.equal(lots[0].availableTokens, payment.tokensSnapshot); // C7
    assert.equal(dbPayment?.providerTransactionId, txId); // C8
    assert.ok(dbPayment?.paidAt, 'paidAt should be populated'); // C9
    assert.equal(typeof dbPayment?.paidAt, 'object');

    // C10: package current values must NOT be re-read; the snapshot governs.
    assert.equal(String(dbPayment!.priceSnapshot), String(pkg.price));
    assert.equal(dbPayment!.tokensSnapshot, pkg.tokens);
    assert.equal(dbPayment!.currencySnapshot, pkg.currency);
  });

  test('C10-extra. Package mutation after snapshot does not change settlement (see Group H)', () => {
    assert.ok(true);
  });

  /* ================= GROUP D — DUPLICATE / IDEMPOTENCY ================= */

  test('D1. Same success webhook sent twice sequentially credits exactly once', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const txId = 'paymob-d1-' + crypto.randomUUID();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, id: txId }));
    assert.equal((await postWebhook(body, hmac)).status, 200);
    assert.equal((await postWebhook(body, hmac)).status, 200);
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.COMPLETED);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 100);
    assert.equal(await purchaseTxCountFor(payment.userId), 1);
    assert.equal(await fundingLotCountFor(payment.userId), 1);
  });

  test('D2. Same success webhook repeated several times still credits once', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const txId = 'paymob-d2-' + crypto.randomUUID();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, id: txId }));
    for (let i = 0; i < 5; i++) {
      assert.equal((await postWebhook(body, hmac)).status, 200);
    }
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 100);
    assert.equal(await purchaseTxCountFor(payment.userId), 1);
    assert.equal(await fundingLotCountFor(payment.userId), 1);
  });

  test('D3. COMPLETED payment + same providerTransactionId replay is an idempotent no-op', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const txId = 'paymob-d3-' + crypto.randomUUID();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, id: txId }));
    assert.equal((await postWebhook(body, hmac)).status, 200);
    // Mark COMPLETED already; replay identical -> no-op, still COMPLETED, no double credit
    assert.equal((await postWebhook(body, hmac)).status, 200);
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.COMPLETED);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 100);
    assert.equal(await purchaseTxCountFor(payment.userId), 1);
  });

  test('D4. COMPLETED payment + DIFFERENT providerTransactionId is rejected, no second credit', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const tx1 = 'paymob-d4a-' + crypto.randomUUID();
    const tx2 = 'paymob-d4b-' + crypto.randomUUID();
    const first = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, id: tx1 }));
    assert.equal((await postWebhook(first.body, first.hmac)).status, 200);
    const second = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, id: tx2 }));
    const res = await postWebhook(second.body, second.hmac);
    assert.ok([409, 200].includes(res.status), `expected 409 or safe 200, got ${res.status}`);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 100);
    assert.equal(await purchaseTxCountFor(payment.userId), 1);
    assert.equal(await fundingLotCountFor(payment.userId), 1);
  });

  test('D5. Same Paymob transaction id attempting to fund another Payment is blocked (no second funding)', async () => {
    const userA = await createUser();
    const pkgA = await createPackage({ price: '10.00', tokens: 100, currency: 'EGP' });
    const paymentA = await createPayment(userA.id, pkgA);
    const walletA = await createWallet(userA.id, 0);
    const userB = await createUser();
    const pkgB = await createPackage({ price: '10.00', tokens: 100, currency: 'EGP' });
    const paymentB = await createPayment(userB.id, pkgB);
    const walletB = await createWallet(userB.id, 0);
    const txId = 'paymob-d5-' + crypto.randomUUID();

    const a = signedPayload(buildObj({ order: { merchant_order_id: paymentA.id }, id: txId }));
    assert.equal((await postWebhook(a.body, a.hmac)).status, 200);

    const b = signedPayload(buildObj({ order: { merchant_order_id: paymentB.id }, id: txId }));
    const resB = await postWebhook(b.body, b.hmac);
    assert.equal(resB.status, 409);
    // B must remain PENDING (or at least not double-funded) and its wallet untouched
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: walletB.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(userB.id), 0);
    assert.equal(await fundingLotCountFor(userB.id), 0);
    // A is the only one funded
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: walletA.id } }))?.tokenBalance, 100);
    assert.equal(await purchaseTxCountFor(userA.id), 1);
  });

  /* ================= GROUP E — CONCURRENCY ================= */

  test('E1. 10 concurrent identical webhooks credit exactly once', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const txId = 'paymob-e1-' + crypto.randomUUID();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, id: txId }));

    const results = await Promise.all(
      Array.from({ length: 10 }, () => postWebhook(body, hmac)),
    );
    for (const r of results) {
      assert.equal(r.status, 200, `concurrent webhook returned ${r.status}`);
    }
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.COMPLETED);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 100);
    assert.equal(await purchaseTxCountFor(payment.userId), 1);
    assert.equal(await fundingLotCountFor(payment.userId), 1);
  });

  /* ================= GROUP F — DATABASE ROLLBACK (atomicity) ================= */

  test('F1. Forced failure after Payment claim rolls back wallet/ledger/funding atomically', async () => {
    // Inject a conflict: an unrelated wallet already holds a PURCHASE TokenTransaction
    // with the exact referenceId this webhook will use. Inside the atomic
    // transaction the create() throws P2002 AFTER the Payment claim + wallet
    // credit, so the whole $transaction must roll back.
    const blockerUser = await createUser();
    const blockerWallet = await createWallet(blockerUser.id, 0);
    const conflictRef = 'paymob-f1-' + crypto.randomUUID();
    const blockerTx = await prisma.tokenTransaction.create({
      data: {
        walletId: blockerWallet.id,
        userId: blockerUser.id,
        type: TokenTransactionType.GRANT,
        tokens: 100,
        source: TokenTransactionSource.PURCHASE,
        paymentId: null,
        referenceId: conflictRef,
      },
    });
    void blockerTx;

    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, id: conflictRef }));
    const res = await postWebhook(body, hmac);
    assert.equal(res.status, 409);

    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.PENDING);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
    assert.equal(await fundingLotCountFor(payment.userId), 0);
  });

  /* ================= GROUP G — PAYMENT STATES ================= */

  test('G1. pending=true keeps Payment as PENDING with no credit', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, pending: true }));
    assert.equal((await postWebhook(body, hmac)).status, 200);
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.PENDING);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
  });

  test('G2. failed transaction (success=false) moves Payment to FAILED with no credit', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, success: false }));
    assert.equal((await postWebhook(body, hmac)).status, 200);
    const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(dbPayment?.status, PaymentStatus.FAILED);
    assert.equal(dbPayment?.failureReason, 'PAYMOB_PAYMENT_FAILED');
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
  });

  test('G2b. error_occured=true (success=true) treated as failure, no credit', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, error_occured: true }));
    assert.equal((await postWebhook(body, hmac)).status, 200);
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.FAILED);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
  });

  test('G3. failure callback after COMPLETED leaves it COMPLETED with no mutation', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const ok = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, id: 'paymob-g3a-' + crypto.randomUUID() }));
    assert.equal((await postWebhook(ok.body, ok.hmac)).status, 200);
    const fail = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, success: false, id: 'paymob-g3b-' + crypto.randomUUID() }));
    assert.equal((await postWebhook(fail.body, fail.hmac)).status, 200);
    const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    assert.equal(dbPayment?.status, PaymentStatus.COMPLETED);
    assert.equal(dbPayment?.failureReason, null);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 100);
    assert.equal(await purchaseTxCountFor(payment.userId), 1);
  });

  test('G4. success callback after FAILED is dropped (FAILED terminality) — CURRENT CONTRACT (known P3 limitation)', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const fail = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, success: false, id: 'paymob-g4a-' + crypto.randomUUID() }));
    assert.equal((await postWebhook(fail.body, fail.hmac)).status, 200);
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.FAILED);
    const ok = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, id: 'paymob-g4b-' + crypto.randomUUID() }));
    const res = await postWebhook(ok.body, ok.hmac);
    assert.equal(res.status, 200);
    const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    // Current contract: FAILED is terminal, later success is dropped (no credit).
    assert.equal(dbPayment?.status, PaymentStatus.FAILED);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(payment.userId), 0);
  });

  /* ================= GROUP H — PACKAGE SNAPSHOT ================= */

  test('H1. Mutable package price/tokens cannot alter an existing purchase', async () => {
    const user = await createUser();
    const pkg = await createPackage({ price: '10.00', tokens: 100, currency: 'EGP' });
    const payment = await createPayment(user.id, pkg);
    const wallet = await createWallet(user.id, 0);
    // Mutate current package values AFTER the snapshot was captured
    await prisma.tokenPackage.update({
      where: { id: pkg.id },
      data: { price: '75.50', tokens: 500, currency: 'USD' },
    });
    // Send original X (10.00 => 1000 cents) with Y (100 tokens)
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id } }));
    assert.equal((await postWebhook(body, hmac)).status, 200);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet.id } }))?.tokenBalance, 100);
    assert.equal((await prisma.payment.findUnique({ where: { id: payment.id } }))?.status, PaymentStatus.COMPLETED);
    const tx = await prisma.tokenTransaction.findFirst({ where: { userId: user.id } });
    assert.equal(tx?.tokens, 100); // Y snapshot, not Y2
  });

  /* ================= GROUP I — WALLET MAX EDGE ================= */

  test('I1. MAX_TOKEN_BALANCE cap edge: wallet not credited, no tx/lot, payment FAILED(MAX_TOKEN_BALANCE_EXCEEDED)', async () => {
    const user = await createUser();
    const pkg = await createPackage({ price: '10.00', tokens: 100, currency: 'EGP' });
    const payment = await createPayment(user.id, pkg);
    const nearMax = MAX_TOKEN_BALANCE - 50 + 1; // 51 short => +100 exceeds cap
    const wallet = await createWallet(user.id, nearMax);
    const txId = 'paymob-i1-' + crypto.randomUUID();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, id: txId }));
    const res = await postWebhook(body, hmac);
    assert.equal(res.status, 200);
    const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    const dbWallet = await prisma.tokenWallet.findUnique({ where: { id: wallet.id } });
    assert.equal(dbWallet?.tokenBalance, nearMax); // wallet not credited
    assert.equal(await purchaseTxCountFor(user.id), 0);
    assert.equal(await fundingLotCountFor(user.id), 0);
    // Current behavior: claim is COMPLETED then downgraded to FAILED with the reason
    assert.equal(dbPayment?.status, PaymentStatus.FAILED);
    assert.equal(dbPayment?.failureReason, 'MAX_TOKEN_BALANCE_EXCEEDED');
  });

  /* ================= GROUP J — OWNERSHIP ================= */

  test('J1. Only the correct user wallet is credited; no cross-user redirect', async () => {
    const userA = await createUser();
    const pkgA = await createPackage({ price: '10.00', tokens: 100, currency: 'EGP' });
    const paymentA = await createPayment(userA.id, pkgA);
    const walletA = await createWallet(userA.id, 0);
    const userB = await createUser();
    const walletB = await createWallet(userB.id, 0);

    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: paymentA.id } }));
    assert.equal((await postWebhook(body, hmac)).status, 200);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: walletA.id } }))?.tokenBalance, 100);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: walletB.id } }))?.tokenBalance, 0);
    assert.equal(await purchaseTxCountFor(userA.id), 1);
    assert.equal(await purchaseTxCountFor(userB.id), 0);
  });

  /* ================= GROUP K — SECRET / PAYLOAD SAFETY ================= */

  test('K1. No card/pan data is persisted to Payment or TokenTransaction on success', async () => {
    const { payment } = await makePendingPurchase();
    const pan = '4111111111111111';
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, source_data: { pan, sub_type: 'MasterCard', type: 'card' } }));
    assert.equal((await postWebhook(body, hmac)).status, 200);
    const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    const dbTx = await prisma.tokenTransaction.findFirst({ where: { userId: payment.userId } });
    // providerData is not written by the webhook (null), and no pan in tx metadata
    assert.ok(!JSON.stringify(dbPayment?.providerData ?? {}).includes(pan));
    const meta = dbTx?.metadata as Record<string, unknown> | null;
    assert.deepEqual(meta, {
      paymentId: payment.id,
      tokenPackageId: payment.tokenPackageId,
      packageNameSnapshot: payment.packageNameSnapshot,
    });
    assert.equal((await prisma.tokenWallet.findUnique({ where: { userId: payment.userId } }))?.tokenBalance, 100);
  });

  test('K2. Test HMAC secret is a placeholder, never a real secret', () => {
    assert.equal(TEST_HMAC_SECRET, 'paymob_hmac_secret_here');
    assert.ok(!TEST_HMAC_SECRET.includes('SECRET_TO_REPLACE'));
    assert.notEqual(TEST_HMAC_SECRET, '');
  });

  /* ================= OPTIONAL CHARACTERIZATION — is_capture ================= */

  test('CHAR1. is_capture=false with success=true DOES credit (current behavior, known P3 limitation)', async () => {
    const { payment, wallet } = await makePendingPurchase();
    const { body, hmac } = signedPayload(buildObj({ order: { merchant_order_id: payment.id }, is_capture: false, is_standalone_payment: false }));
    assert.equal((await postWebhook(body, hmac)).status, 200);
    const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    // Current contract: is_capture is NOT required by the success branch.
    assert.equal(dbPayment?.status, PaymentStatus.COMPLETED);
    assert.equal((await prisma.tokenWallet.findUnique({ where: { id: wallet!.id } }))?.tokenBalance, 100);
    assert.equal(await purchaseTxCountFor(payment.userId), 1);
  });
});
