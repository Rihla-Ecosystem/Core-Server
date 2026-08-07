import { Prisma, TokenTransactionSource, TokenTransactionType } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { walletPolicyConfig } from '../config/env.js';
import { MAX_TOKEN_BALANCE } from '../config/business-token-features.js';
import { isTokenExemptUser } from '../utils/token-exempt.js';

/**
 * Phase 2G-A first-successful-login free-tier grant.
 *
 * Rules (locked):
 *  - The free-tier Wallet grant moves from registration to the FIRST successful
 *    tourist login. No grant is issued on failed login or on registration alone.
 *  - Admins / system identities are never granted.
 *  - The grant is issued exactly once (never twice) with a stable unique
 *    referenceId; the unique `(source, referenceId)` constraint makes it
 *    concurrency-safe.
 *  - An existing OLD registration-time signup grant (`signup-grant:<userId>`
 *    marker) counts as already granted — no top-up for pre-cutover users.
 *  - `MAX_TOKEN_BALANCE` is respected: only the remaining headroom is granted.
 *  - The grant is best-effort: a grant write failure must never fail a login.
 */

export type FirstLoginGrantReason =
  | 'GRANTED'
  | 'ALREADY_GRANTED'
  | 'GRANT_DISABLED'
  | 'USER_EXEMPT'
  | 'BALANCE_AT_MAX'
  | 'NO_USER'
  | 'GRANT_ERROR';

export interface FirstLoginGrantResult {
  userId: string;
  reason: FirstLoginGrantReason;
  grantedTokens: number;
  walletId: string | null;
  balance: number;
}

const OLD_SIGNUP_GRANT_REFERENCE = (userId: string) => `signup-grant:${userId}`;
const FIRST_LOGIN_GRANT_REFERENCE = (userId: string) => `first-login-grant:${userId}`;

function isSourceReferenceUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;

  const target = error.meta?.target;

  if (Array.isArray(target)) {
    const fields = target.filter((item): item is string => typeof item === 'string');
    return (
      fields.length === 2 &&
      fields.includes('source') &&
      fields.includes('referenceId')
    );
  }

  if (typeof target === 'string') {
    return target.includes('source') && target.includes('referenceId');
  }

  return false;
}

async function hasExistingGrantMarker(userId: string): Promise<boolean> {
  const count = await prisma.tokenTransaction.count({
    where: {
      userId,
      type: TokenTransactionType.GRANT,
      referenceId: {
        in: [FIRST_LOGIN_GRANT_REFERENCE(userId), OLD_SIGNUP_GRANT_REFERENCE(userId)],
      },
    },
  });
  return count > 0;
}

async function readWalletState(
  userId: string,
): Promise<{ walletId: string | null; balance: number }> {
  const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
  return { walletId: wallet?.id ?? null, balance: wallet?.tokenBalance ?? 0 };
}

/**
 * Issue the first-successful-login free-tier grant, idempotently and
 * concurrently safely. Never throws; callers treat it as best-effort.
 */
export async function grantFirstLoginTokens(userId: string): Promise<FirstLoginGrantResult> {
  const grant = walletPolicyConfig.signupTokenGrant;
  if (!Number.isSafeInteger(grant) || grant <= 0) {
    return { userId, reason: 'GRANT_DISABLED', grantedTokens: 0, walletId: null, balance: 0 };
  }

  const existing = await hasExistingGrantMarker(userId);
  if (existing) {
    const state = await readWalletState(userId);
    return { userId, reason: 'ALREADY_GRANTED', grantedTokens: 0, ...state };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: { select: { name: true } } },
  });
  if (!user) {
    return { userId, reason: 'NO_USER', grantedTokens: 0, walletId: null, balance: 0 };
  }
  if (isTokenExemptUser(user)) {
    return { userId, reason: 'USER_EXEMPT', grantedTokens: 0, walletId: null, balance: 0 };
  }

  const referenceId = FIRST_LOGIN_GRANT_REFERENCE(userId);

  try {
    return await prisma.$transaction(async (tx) => {
      const wallet = await tx.tokenWallet.findUnique({ where: { userId } });
      const currentBalance = wallet?.tokenBalance ?? 0;
      if (currentBalance >= MAX_TOKEN_BALANCE) {
        return {
          userId,
          reason: 'BALANCE_AT_MAX',
          grantedTokens: 0,
          walletId: wallet?.id ?? null,
          balance: currentBalance,
        };
      }

      const actualGrant = Math.min(grant, MAX_TOKEN_BALANCE - currentBalance);

      const updatedWallet = await tx.tokenWallet.upsert({
        where: { userId },
        create: { userId, tokenBalance: actualGrant, status: 'ACTIVE' },
        update: { tokenBalance: { increment: actualGrant } },
      });

      await tx.tokenTransaction.create({
        data: {
          walletId: updatedWallet.id,
          userId,
          type: TokenTransactionType.GRANT,
          tokens: actualGrant,
          source: TokenTransactionSource.ADMIN,
          paymentId: null,
          referenceId,
          metadata: {
            reason: 'FIRST_LOGIN_GRANT',
            policyVersion: walletPolicyConfig.version,
          },
        },
      });

      return {
        userId,
        reason: 'GRANTED',
        grantedTokens: actualGrant,
        walletId: updatedWallet.id,
        balance: updatedWallet.tokenBalance,
      };
    });
  } catch (err) {
    if (isSourceReferenceUniqueViolation(err)) {
      // A concurrent first-login grant won the race; a marker already exists.
      const state = await readWalletState(userId);
      return { userId, reason: 'ALREADY_GRANTED', grantedTokens: 0, ...state };
    }
    console.error('[wallet] first_login_grant_failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { userId, reason: 'GRANT_ERROR', grantedTokens: 0, walletId: null, balance: 0 };
  }
}
