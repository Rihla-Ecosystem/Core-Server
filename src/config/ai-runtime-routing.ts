import type { BusinessTokenFeature } from './business-token-features.js';

/** Runtime model identities mirrored from AI Service's configured Gemini routes. */
export const GEMINI_TEXT_RUNTIME_MODELS = Object.freeze([
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
] as const);

export const GEMINI_TTS_RUNTIME_MODEL = 'gemini-3.1-flash-tts-preview';

export interface RuntimeModelRoute {
  textModels: readonly string[];
  ttsModels?: readonly string[];
}

export const AI_RUNTIME_MODEL_ROUTES: Readonly<Record<BusinessTokenFeature, RuntimeModelRoute>> = Object.freeze({
  AI_CHAT_QUERY: { textModels: GEMINI_TEXT_RUNTIME_MODELS },
  AI_IMAGE_ANALYSIS: { textModels: GEMINI_TEXT_RUNTIME_MODELS },
  REAL_TIME_TRANSLATION: { textModels: GEMINI_TEXT_RUNTIME_MODELS, ttsModels: [GEMINI_TTS_RUNTIME_MODEL] },
  AI_TRIP_ITINERARY: { textModels: GEMINI_TEXT_RUNTIME_MODELS },
});
