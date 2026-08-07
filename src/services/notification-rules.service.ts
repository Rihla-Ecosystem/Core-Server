// ---------------------------------------------------------------------------
// Smart Notification Rules Engine
// ---------------------------------------------------------------------------
// Generates context-aware notifications from an aggregated Context Object,
// applies cooldown rules, prevents duplicates, and prioritizes critical alerts.
import type {
  ContextObject,
  GeneratedNotification,
} from '../types/context-notification.js';

export interface RuleContext extends ContextObject {}

export interface RuleEvaluation {
  rule: string;
  triggered: boolean;
  notification: GeneratedNotification;
}

// Cooldown window (ms) per rule to prevent duplicate spam.
export const RULE_COOLDOWN_MS: Record<string, number> = {
  entering_restricted_area: 30 * 60 * 1000, // 30 min
  approaching_restricted_area: 60 * 60 * 1000,
  photography_restricted: 30 * 60 * 1000,
  entering_dangerous_area: 30 * 60 * 1000,
  nearby_emergency: 10 * 60 * 1000,
  nearby_tourist_attraction: 3 * 60 * 60 * 1000,
  nearby_historical_site: 3 * 60 * 60 * 1000,
  severe_weather: 60 * 60 * 1000,
  heavy_traffic: 30 * 60 * 1000,
};

const CRITICAL = 'CRITICAL' as const;
const HIGH = 'HIGH' as const;
const NORMAL = 'NORMAL' as const;
const LOW = 'LOW' as const;

function push(
  out: RuleEvaluation[],
  rule: string,
  triggered: boolean,
  n: Omit<GeneratedNotification, 'cooldownKey'> & { cooldownKey?: string },
): void {
  out.push({
    rule,
    triggered,
    notification: { ...n, cooldownKey: n.cooldownKey ?? rule },
  });
}

export function evaluateRules(ctx: RuleContext): RuleEvaluation[] {
  const out: RuleEvaluation[] = [];
  const { geoContext, riskContext, location } = ctx;

  const restricted = geoContext.restrictedAreas ?? [];
  const photographyRestricted = (geoContext.photographyRestrictions ?? []).length > 0;
  const atRestricted = restricted.length > 0;
  const inDangerous = (riskContext.riskLevel ?? '').toLowerCase() === 'critical' ||
    (riskContext.riskLevel ?? '').toLowerCase() === 'warning';
  const emergencies = riskContext.emergencyEvents ?? [];
  const nearbyAttractions = geoContext.nearbyAttractions ?? [];
  const nearbyHistorical = geoContext.historicalPlaces ?? [];
  const threats = riskContext.threats ?? [];

  const weatherThreat = threats.find(
    (t) => (t.category ?? '').toLowerCase() === 'weather' && (t.severity ?? '') !== 'info',
  );
  const trafficThreat = threats.find(
    (t) => (t.category ?? '').toLowerCase() === 'traffic',
  );

  // 1. Entering a restricted area
  push(
    out,
    'entering_restricted_area',
    atRestricted,
    {
      title: 'Restricted Area Warning',
      message: restricted
        .map((r) => `${r.name ?? 'This area'}${r.reason ? ` — ${r.reason}` : ''}`)
        .join('. ') || 'You have entered a restricted area.',
      type: 'WARNING',
      category: 'RESTRICTED_AREA',
      priority: atRestricted ? HIGH : LOW,
      source: 'CONTEXT',
      lat: location.lat,
      lng: location.lng,
      data: { restrictedAreas: restricted },
    },
  );

  // 2. Approaching a restricted area (client-side geofence exit keeps us aware)
  push(
    out,
    'approaching_restricted_area',
    false,
    {
      title: 'Approaching Restricted Area',
      message: 'A restricted area is nearby. Please stay cautious.',
      type: 'WARNING',
      category: 'RESTRICTED_AREA',
      priority: NORMAL,
      source: 'CONTEXT',
      lat: location.lat,
      lng: location.lng,
    },
  );

  // 3. Entering a photography restricted zone
  push(
    out,
    'photography_restricted',
    photographyRestricted,
    {
      title: 'Photography Restricted',
      message: photographyRestricted
        ? (geoContext.photographyRestrictions ?? []).join(' ')
        : 'Photography is restricted in this area.',
      type: 'WARNING',
      category: 'PHOTOGRAPHY',
      priority: NORMAL,
      source: 'CONTEXT',
      lat: location.lat,
      lng: location.lng,
    },
  );

  // 4. Entering a dangerous area
  push(
    out,
    'entering_dangerous_area',
    inDangerous,
    {
      title: 'High Risk Alert',
      message:
        inDangerous
          ? `This area currently has a ${riskContext.riskLevel ?? 'elevated'} risk level. Please stay vigilant.`
          : 'Safety conditions are elevated in this area.',
      type: 'ERROR',
      category: 'SAFETY',
      priority: inDangerous ? HIGH : NORMAL,
      source: 'CONTEXT',
      lat: location.lat,
      lng: location.lng,
      data: { riskLevel: riskContext.riskLevel },
    },
  );

  // 5. Nearby emergency
  push(
    out,
    'nearby_emergency',
    emergencies.length > 0,
    {
      title: 'Emergency Warning',
      message: emergencies
        .map((e) => `${e.headline ?? 'Emergency event'}${e.detail ? ` (${e.detail})` : ''}`)
        .join(' | '),
      type: 'ERROR',
      category: 'EMERGENCY',
      priority: CRITICAL,
      source: 'EMERGENCY',
      lat: location.lat,
      lng: location.lng,
      data: { emergencyEvents: emergencies },
    },
  );

  // 6. Nearby tourist attraction
  push(
    out,
    'nearby_tourist_attraction',
    nearbyAttractions.length > 0,
    {
      title: 'Tourist Recommendation',
      message: `You are near ${nearbyAttractions
        .slice(0, 3)
        .map((a) => a.name)
        .join(', ') || 'a popular attraction'}.`,
      type: 'SUCCESS',
      category: 'TOURIST',
      priority: LOW,
      source: 'AI',
      lat: location.lat,
      lng: location.lng,
      data: { attractions: nearbyAttractions.slice(0, 3) },
    },
  );

  // 7. Nearby historical site
  push(
    out,
    'nearby_historical_site',
    nearbyHistorical.length > 0,
    {
      title: 'Historical Site Nearby',
      message: `Discover ${nearbyHistorical
        .slice(0, 3)
        .map((h) => h.name)
        .join(', ') || 'an important historical site'} near you.`,
      type: 'INFO',
      category: 'HISTORICAL',
      priority: LOW,
      source: 'AI',
      lat: location.lat,
      lng: location.lng,
      data: { historical: nearbyHistorical.slice(0, 3) },
    },
  );

  // 8. Severe weather nearby
  push(
    out,
    'severe_weather',
    !!weatherThreat,
    {
      title: 'Severe Weather Nearby',
      message: weatherThreat?.headline ?? 'Severe weather conditions reported nearby.',
      type: 'WARNING',
      category: 'WEATHER',
      priority: weatherThreat?.severity === 'critical' ? CRITICAL : HIGH,
      source: 'CONTEXT',
      lat: location.lat,
      lng: location.lng,
      data: weatherThreat ? { threat: weatherThreat } : undefined,
    },
  );

  // 9. Heavy traffic nearby
  push(
    out,
    'heavy_traffic',
    !!trafficThreat,
    {
      title: 'Heavy Traffic Nearby',
      message: trafficThreat?.headline ?? 'Heavy traffic is reported nearby.',
      type: 'WARNING',
      category: 'TRAFFIC',
      priority: NORMAL,
      source: 'CONTEXT',
      lat: location.lat,
      lng: location.lng,
      data: trafficThreat ? { threat: trafficThreat } : undefined,
    },
  );

  return out;
}

/**
 * Keep only triggered rules, sorted by descending priority (CRITICAL first).
 */
export function prioritizeEvaluations(evals: RuleEvaluation[]): RuleEvaluation[] {
  const rank: Record<string, number> = { CRITICAL: 4, HIGH: 3, NORMAL: 2, LOW: 1 };
  return evals
    .filter((e) => e.triggered)
    .sort((a, b) => rank[b.notification.priority] - rank[a.notification.priority]);
}

/**
 * Persist cooldown markers so the same rule cannot fire repeatedly within the
 * window. Returns the set of rules that are currently allowed to fire.
 * Deduplication key = rule name.
 */
export function buildCooldownKeys(evals: RuleEvaluation[]): string[] {
  return evals.map((e) => e.notification.cooldownKey || e.rule);
}
