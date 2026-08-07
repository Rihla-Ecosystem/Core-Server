import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWalletPolicyConfig,
  WalletPolicyConfigurationError,
  DEFAULT_SIGNUP_TOKEN_GRANT,
  DEFAULT_WALLET_TOKEN_VALUE_NANO_USD,
  DEFAULT_WALLET_MARKUP_BASIS_POINTS,
  DEFAULT_MINIMUM_WALLET_CHARGE,
  DEFAULT_MAX_RESERVATION_TOKENS,
  WALLET_POLICY_VERSION,
} from '../src/config/wallet-policy.js';

describe('Wallet policy config - defaults', () => {
  test('1. Missing values fall back to the documented defaults', () => {
    const config = parseWalletPolicyConfig({});
    assert.equal(config.signupTokenGrant, DEFAULT_SIGNUP_TOKEN_GRANT);
    assert.equal(config.signupTokenGrant, 100);
    assert.equal(config.walletTokenValueNanoUsd, DEFAULT_WALLET_TOKEN_VALUE_NANO_USD);
    assert.equal(config.walletTokenValueNanoUsd, 100000);
    assert.equal(config.markupBasisPoints, DEFAULT_WALLET_MARKUP_BASIS_POINTS);
    assert.equal(config.markupBasisPoints, 10000);
    assert.equal(config.minimumWalletTokens, DEFAULT_MINIMUM_WALLET_CHARGE);
    assert.equal(config.minimumWalletTokens, 1);
    assert.equal(config.version, WALLET_POLICY_VERSION);
    for (const value of Object.values(config.maxReservationTokensByFeature)) {
      assert.equal(value, DEFAULT_MAX_RESERVATION_TOKENS);
    }
    assert.equal(Object.isFrozen(config), true);
  });
});

describe('Wallet policy config - strict parsing', () => {
  test('2. Negative values are rejected', () => {
    assert.throws(
      () => parseWalletPolicyConfig({ WALLET_MARKUP_BASIS_POINTS: '-5000' }),
      WalletPolicyConfigurationError,
    );
    assert.throws(
      () => parseWalletPolicyConfig({ MINIMUM_WALLET_CHARGE: '-1' }),
      WalletPolicyConfigurationError,
    );
  });

  test('3. Decimals where integers are required are rejected', () => {
    assert.throws(
      () => parseWalletPolicyConfig({ WALLET_TOKEN_VALUE_NANO_USD: '100000.5' }),
      WalletPolicyConfigurationError,
    );
    assert.throws(
      () => parseWalletPolicyConfig({ WALLET_MARKUP_BASIS_POINTS: '10000.0' }),
      WalletPolicyConfigurationError,
    );
  });

  test('4. Malformed strings are rejected, never silently coerced', () => {
    assert.throws(
      () => parseWalletPolicyConfig({ WALLET_TOKEN_VALUE_NANO_USD: 'abc' }),
      WalletPolicyConfigurationError,
    );
    assert.throws(
      () => parseWalletPolicyConfig({ SIGNUP_TOKEN_GRANT: '' }),
      WalletPolicyConfigurationError,
    );
  });

  test('5. Unsafe integers are rejected', () => {
    assert.throws(
      () => parseWalletPolicyConfig({ SIGNUP_TOKEN_GRANT: '9007199254740992' }),
      WalletPolicyConfigurationError,
    );
  });

  test('6. Explicit valid values are accepted', () => {
    const config = parseWalletPolicyConfig({
      SIGNUP_TOKEN_GRANT: '50',
      WALLET_TOKEN_VALUE_NANO_USD: '50000',
      WALLET_MARKUP_BASIS_POINTS: '11000',
      MINIMUM_WALLET_CHARGE: '2',
    });
    assert.equal(config.signupTokenGrant, 50);
    assert.equal(config.walletTokenValueNanoUsd, 50000);
    assert.equal(config.markupBasisPoints, 11000);
    assert.equal(config.minimumWalletTokens, 2);
  });
});

describe('Wallet policy config - legacy billing mode removed (Phase 2G-B)', () => {
  test('7. The legacy billing mode field is gone from the parsed policy', () => {
    const config = parseWalletPolicyConfig({});
    assert.equal('billingMode' in config, false);
  });

  test('8. AI_WALLET_BILLING_MODE is no longer consumed by the parser', () => {
    const config = parseWalletPolicyConfig({
      AI_WALLET_BILLING_MODE: 'FIXED',
      SIGNUP_TOKEN_GRANT: '60',
    });
    assert.equal(config.signupTokenGrant, 60);
    assert.equal('billingMode' in config, false);
  });
});

describe('Wallet policy config - reservation ceilings', () => {
  test('10. Unknown features in the reservation JSON are rejected', () => {
    assert.throws(
      () =>
        parseWalletPolicyConfig({
          AI_BILLING_MAX_RESERVATION_TOKENS: JSON.stringify({ NOT_A_FEATURE: 5 }),
        }),
      WalletPolicyConfigurationError,
    );
  });

  test('11. Ceilings below the fixed feature cost are rejected', () => {
    assert.throws(
      () =>
        parseWalletPolicyConfig({
          AI_BILLING_MAX_RESERVATION_TOKENS: JSON.stringify({ AI_CHAT_QUERY: 0 }),
        }),
      WalletPolicyConfigurationError,
    );
  });

  test('12. Valid per-feature ceilings are applied', () => {
    const config = parseWalletPolicyConfig({
      AI_BILLING_MAX_RESERVATION_TOKENS: JSON.stringify({
        AI_CHAT_QUERY: 200,
        AI_IMAGE_ANALYSIS: 150,
      }),
    });
    assert.equal(config.maxReservationTokensByFeature.AI_CHAT_QUERY, 200);
    assert.equal(config.maxReservationTokensByFeature.AI_IMAGE_ANALYSIS, 150);
    assert.equal(
      config.maxReservationTokensByFeature.AI_TRIP_ITINERARY,
      DEFAULT_MAX_RESERVATION_TOKENS,
    );
  });
});
