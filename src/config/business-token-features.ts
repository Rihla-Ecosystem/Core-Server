export const BUSINESS_TOKEN_FEATURE_COSTS = {
  AI_TRIP_ITINERARY: 10,
  AI_CHAT_QUERY: 2,
  REAL_TIME_TRANSLATION: 3,
  PERSONALIZED_RECOMMENDATIONS: 5,
  OFFLINE_MAP_DOWNLOAD: 8,
  SMART_BUDGET_PLANNER: 6,
  LOCAL_AUDIO_GUIDE: 12,
  BOOKING_PRICE_COMPARISON: 4,
} as const;

export type BusinessTokenFeature = keyof typeof BUSINESS_TOKEN_FEATURE_COSTS;

export type BusinessTokenCost = (typeof BUSINESS_TOKEN_FEATURE_COSTS)[BusinessTokenFeature];

// Object.keys on the as-const catalogue returns exactly its own keys, so
// narrowing to BusinessTokenFeature[] is the smallest safe assertion here.
export const BUSINESS_TOKEN_FEATURES: readonly BusinessTokenFeature[] =
  Object.keys(BUSINESS_TOKEN_FEATURE_COSTS) as BusinessTokenFeature[];

export function getBusinessTokenCost(feature: BusinessTokenFeature): BusinessTokenCost {
  return BUSINESS_TOKEN_FEATURE_COSTS[feature];
}

for (const feature of BUSINESS_TOKEN_FEATURES) {
  const cost = BUSINESS_TOKEN_FEATURE_COSTS[feature];
  if (!Number.isInteger(cost) || cost <= 0) {
    throw new Error(`Invalid token cost configured for business feature: ${feature}`);
  }
}
