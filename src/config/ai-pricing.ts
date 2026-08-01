import { env } from './env.js';

/**
 * Approximate Google Gemini pricing in USD per 1M tokens.
 * Overridable via the AI_PRICING_JSON env var, e.g.:
 *   AI_PRICING_JSON='{"gemini-3.6-flash":{"input":0.3,"output":2.5}}'
 */

interface ModelPrice {
  input: number;
  output: number;
}

const DEFAULT_PRICE: ModelPrice = { input: 0.3, output: 2.5 };

const FALLBACK_PRICES: Record<string, ModelPrice> = {
  'gemini-3.6-flash': { input: 0.3, output: 2.5 },
  'gemini-3.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-3-flash-preview': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
};

function loadEnvPrices(): Record<string, ModelPrice> {
  if (!env.AI_PRICING_JSON) return {};
  try {
    const parsed = JSON.parse(env.AI_PRICING_JSON);
    const out: Record<string, ModelPrice> = {};
    for (const [model, price] of Object.entries(parsed)) {
      const p = price as { input?: number; output?: number };
      out[model] = {
        input: Number(p.input) || 0,
        output: Number(p.output) || 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

const envPrices = loadEnvPrices();

function matchPrice(model: string | null | undefined): ModelPrice {
  if (!model) return DEFAULT_PRICE;
  if (envPrices[model]) return envPrices[model];
  const lower = model.toLowerCase();
  if (FALLBACK_PRICES[model]) return FALLBACK_PRICES[model];
  if (lower.includes('lite')) return FALLBACK_PRICES['gemini-3.5-flash-lite'];
  if (lower.includes('flash')) return DEFAULT_PRICE;
  return DEFAULT_PRICE;
}

export function computeAiCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = matchPrice(model);
  return (
    (inputTokens / 1_000_000) * price.input +
    (outputTokens / 1_000_000) * price.output
  );
}
