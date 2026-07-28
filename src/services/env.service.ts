export interface EnvContext {
  weather?: unknown;
  airQuality?: unknown;
  prayerTimes?: unknown;
  holidays?: unknown;
  currency?: unknown;
  overview?: unknown;
}

export async function fetchEnvContext(_lat: number, _lon: number, _authorization?: string): Promise<EnvContext> {
  // Environmental context service (weather, air quality, prayer times) is not yet implemented.
  // See Task 6 in IMPLEMENTATION_PLAN.md for future work.
  return {};
}
