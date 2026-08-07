{
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Safety check failed: DATABASE_URL is not set');
  const parsed = new URL(dbUrl);
  if (parsed.pathname !== '/core_server_test') {
    throw new Error(
      `Safety check failed: DATABASE_URL must point to /core_server_test, got "${parsed.pathname}"`,
    );
  }
}

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules, prioritizeEvaluations, buildCooldownKeys, RULE_COOLDOWN_MS } from '../src/services/notification-rules.service.js';
import type { ContextObject } from '../src/types/context-notification.js';

function makeContext(overrides: Partial<ContextObject> = {}): ContextObject {
  return {
    location: { lat: 30.0444, lng: 31.2357, reason: 'movement' },
    geoContext: {
      inEgypt: true,
      currentArea: 'Cairo',
      governorate: 'Cairo',
      nearbyAttractions: [],
      nearbyServices: [],
      nearbyHotels: [],
      nearbyRestaurants: [],
      nearbyHospitals: [],
      nearbyPoliceStations: [],
      nearbyTransportation: [],
      historicalPlaces: [],
      photographyRestrictions: [],
      restrictedAreas: [],
    },
    riskContext: {
      riskLevel: 'info',
      safetyScore: 92,
      threats: [],
      securityAlerts: [],
      emergencyEvents: [],
      crowdDensity: null,
    },
    userProfile: {},
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Notification rules engine', () => {
  test('no rules trigger for a quiet area', () => {
    const ctx = makeContext();
    const triggered = prioritizeEvaluations(evaluateRules(ctx));
    assert.equal(triggered.length, 0);
  });

  test('entering a restricted area triggers the restricted-area rule', () => {
    const ctx = makeContext({
      geoContext: {
        ...makeContext().geoContext,
        restrictedAreas: [{ name: 'Military Zone', type: 'restricted', reason: 'No entry' }],
      },
    });
    const evals = evaluateRules(ctx);
    const restricted = evals.find((e) => e.rule === 'entering_restricted_area');
    assert.ok(restricted);
    assert.equal(restricted.triggered, true);
    assert.equal(restricted.notification.category, 'RESTRICTED_AREA');
    assert.equal(restricted.notification.priority, 'HIGH');
  });

  test('photography restrictions trigger the photography rule', () => {
    const ctx = makeContext({
      geoContext: {
        ...makeContext().geoContext,
        photographyRestrictions: ['No photography allowed'],
      },
    });
    const evals = evaluateRules(ctx);
    const photo = evals.find((e) => e.rule === 'photography_restricted');
    assert.ok(photo);
    assert.equal(photo.triggered, true);
    assert.equal(photo.notification.title, 'Photography Restricted');
  });

  test('critical risk triggers the dangerous-area rule', () => {
    const ctx = makeContext({
      riskContext: { riskLevel: 'critical', safetyScore: 32, threats: [], securityAlerts: [], emergencyEvents: [], crowdDensity: null },
    });
    const evals = evaluateRules(ctx);
    const dangerous = evals.find((e) => e.rule === 'entering_dangerous_area');
    assert.ok(dangerous);
    assert.equal(dangerous.triggered, true);
    assert.equal(dangerous.notification.title, 'High Risk Alert');
  });

  test('emergency events trigger the emergency rule with CRITICAL priority', () => {
    const ctx = makeContext({
      riskContext: {
        riskLevel: 'warning',
        safetyScore: 50,
        threats: [],
        securityAlerts: [],
        emergencyEvents: [{ category: 'seismic', severity: 'critical', headline: 'M 5.2 earthquake near Cairo' }],
        crowdDensity: null,
      },
    });
    const evals = evaluateRules(ctx);
    const emergency = evals.find((e) => e.rule === 'nearby_emergency');
    assert.ok(emergency);
    assert.equal(emergency.triggered, true);
    assert.equal(emergency.notification.priority, 'CRITICAL');
  });

  test('nearby tourist attraction triggers the recommendation rule', () => {
    const ctx = makeContext({
      geoContext: {
        ...makeContext().geoContext,
        nearbyAttractions: [{ name: 'Egyptian Museum' }],
      },
    });
    const evals = evaluateRules(ctx);
    const tourist = evals.find((e) => e.rule === 'nearby_tourist_attraction');
    assert.ok(tourist);
    assert.equal(tourist.triggered, true);
    assert.equal(tourist.notification.title, 'Tourist Recommendation');
  });

  test('nearby historical site triggers the historical rule', () => {
    const ctx = makeContext({
      geoContext: {
        ...makeContext().geoContext,
        historicalPlaces: [{ name: 'Khan el-Khalili' }],
      },
    });
    const evals = evaluateRules(ctx);
    const historical = evals.find((e) => e.rule === 'nearby_historical_site');
    assert.ok(historical);
    assert.equal(historical.triggered, true);
  });

  test('severe weather triggers the weather rule', () => {
    const ctx = makeContext({
      riskContext: {
        riskLevel: 'warning',
        safetyScore: 58,
        threats: [{ category: 'weather', severity: 'critical', headline: 'Severe sandstorm' }],
        securityAlerts: [],
        emergencyEvents: [],
        crowdDensity: null,
      },
    });
    const evals = evaluateRules(ctx);
    const weather = evals.find((e) => e.rule === 'severe_weather');
    assert.ok(weather);
    assert.equal(weather.triggered, true);
    assert.equal(weather.notification.title, 'Severe Weather Nearby');
  });

  test('critical alerts are prioritized above informational ones', () => {
    const ctx = makeContext({
      geoContext: {
        ...makeContext().geoContext,
        restrictedAreas: [{ name: 'Zone A', reason: 'restricted' }],
        nearbyAttractions: [{ name: 'Museum' }],
      },
      riskContext: {
        riskLevel: 'warning',
        safetyScore: 58,
        threats: [],
        securityAlerts: [],
        emergencyEvents: [{ category: 'fire', severity: 'critical', headline: 'Fire reported' }],
        crowdDensity: null,
      },
    });
    const sorted = prioritizeEvaluations(evaluateRules(ctx));
    assert.ok(sorted.length >= 3);
    assert.equal(sorted[0].rule, 'nearby_emergency');
  });

  test('cooldown keys are deterministic per rule', () => {
    const ctx = makeContext({
      geoContext: { ...makeContext().geoContext, restrictedAreas: [{ name: 'X' }] },
    });
    const evals = evaluateRules(ctx);
    const keys = buildCooldownKeys(evals);
    assert.ok(keys.includes('entering_restricted_area'));
    assert.ok(keys.every((k) => k.length > 0));
  });

  test('cooldown map defines all smart rules', () => {
    const rules = [
      'entering_restricted_area',
      'approaching_restricted_area',
      'photography_restricted',
      'entering_dangerous_area',
      'nearby_emergency',
      'nearby_tourist_attraction',
      'nearby_historical_site',
      'severe_weather',
      'heavy_traffic',
    ];
    for (const r of rules) {
      assert.ok(RULE_COOLDOWN_MS[r], `missing cooldown for ${r}`);
    }
  });
});