import { parseChatLimitsConfig } from './chat-limits.js';

export type AIBilledExecutionFeature =
  | 'AI_CHAT_QUERY'
  | 'AI_IMAGE_ANALYSIS'
  | 'REAL_TIME_TRANSLATION'
  | 'AI_TRIP_ITINERARY'
  | 'AI_CONTEXT_ANALYZE';

/** Business-owned execution constraints sent to the AI Service. */
export interface AIExecutionBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCurrentMessageTokens?: number;
  maxHistoryTokens?: number;
  maxHistoryMessages?: number;
  maxImageBytes?: number;
  maxImagePixels?: number;
  maxAudioBytes?: number;
  maxAudioDurationSeconds?: number;
  maxAudioInputTokens?: number;
  maxTtsCharacters?: number;
  maxTtsOutputTokens?: number;
  maxCities?: number;
  maxInterests?: number;
  maxDays?: number;
}

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VOICE_MAX_BYTES = 10 * 1024 * 1024;

export function getAIExecutionBudget(feature: AIBilledExecutionFeature): Readonly<AIExecutionBudget> {
  const chat = parseChatLimitsConfig(process.env);
  switch (feature) {
    case 'AI_CHAT_QUERY':
      return Object.freeze({
        maxInputTokens: chat.maxInputTokens,
        maxOutputTokens: chat.maxOutputTokens,
        maxCurrentMessageTokens: chat.maxCurrentMessageTokens,
        maxHistoryTokens: chat.historyTokenBudget,
        maxHistoryMessages: chat.maxRecentMessages,
      });
    case 'AI_IMAGE_ANALYSIS':
      return Object.freeze({ maxInputTokens: 3_000, maxOutputTokens: 400, maxImageBytes: IMAGE_MAX_BYTES, maxImagePixels: 20_000_000 });
    case 'REAL_TIME_TRANSLATION':
      return Object.freeze({ maxInputTokens: 1_000, maxOutputTokens: 500, maxAudioBytes: VOICE_MAX_BYTES, maxAudioDurationSeconds: 60, maxAudioInputTokens: 1_920, maxTtsCharacters: 500, maxTtsOutputTokens: 750 });
    case 'AI_TRIP_ITINERARY':
      return Object.freeze({ maxInputTokens: 8_000, maxOutputTokens: 1_000, maxCities: 10, maxInterests: 10, maxDays: 14 });
    case 'AI_CONTEXT_ANALYZE':
      // The /analyze request is a compact, Core-built location/risk digest.
      // Its only provider-visible controls are bounded text input and JSON output.
      return Object.freeze({ maxInputTokens: 2_000, maxOutputTokens: 600 });
  }
}
