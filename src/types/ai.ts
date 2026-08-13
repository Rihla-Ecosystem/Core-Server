export type AIChatPersona = 'auto' | 'tour_guide' | 'local_expert' | 'safety_guru';

export interface AIProviderUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cached?: boolean;
  audioSeconds?: number;
}

/**
 * Provider-neutral record of a single provider call, mirroring the AI Service
 * ProviderCallUsage contract. Unknown numeric fields are absent (never zero).
 * All optional token counts are validated as non-negative integers when present.
 * This contract is intentionally provider-neutral (no Gemini-native fields).
 */
export interface ProviderCallUsage {
  provider: string;
  providerCallMade: boolean;
  providerCallId?: string;
  providerRequestId?: string;
  requestedModel?: string;
  actualModel?: string;
  operation?: string;
  usageSource?: string;
  usageCompleteness?: string;
  accountingSemantics?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cachedOutputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  imageInputTokens?: number;
  imageOutputTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  cachedAudioInputTokens?: number;
  cachedAudioOutputTokens?: number;
  audioInputSeconds?: number;
  audioOutputSeconds?: number;
  transcriptionSeconds?: number;
  inputCharacters?: number;
  outputCharacters?: number;
  generatedImageCount?: number;
}

export interface RawProviderCall {
  provider?: unknown;
  providerCallMade?: unknown;
  providerCallId?: unknown;
  providerRequestId?: unknown;
  requestedModel?: unknown;
  actualModel?: unknown;
  operation?: unknown;
  usageSource?: unknown;
  usageCompleteness?: unknown;
  accountingSemantics?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  cachedInputTokens?: unknown;
  cachedOutputTokens?: unknown;
  cacheWriteInputTokens?: unknown;
  reasoningTokens?: unknown;
  imageInputTokens?: unknown;
  imageOutputTokens?: unknown;
  audioInputTokens?: unknown;
  audioOutputTokens?: unknown;
  cachedAudioInputTokens?: unknown;
  cachedAudioOutputTokens?: unknown;
  audioInputSeconds?: unknown;
  audioOutputSeconds?: unknown;
  transcriptionSeconds?: unknown;
  inputCharacters?: unknown;
  outputCharacters?: unknown;
  generatedImageCount?: unknown;
  [key: string]: unknown;
}

export interface RawAIProviderUsage {
  provider?: unknown;
  model?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  cached?: unknown;
  audioSeconds?: unknown;
  audio_seconds?: unknown;
  [key: string]: unknown;
}

/**
 * Provider-neutral outcome of one attempted provider call (diagnostic only).
 *
 * - `SUCCEEDED`       — a usable provider response was received and the
 *                       corresponding ProviderCallUsage record was recorded.
 * - `FAILED`          — the provider definitively rejected the call (confirmed
 *                       4xx/5xx / explicit rejection); no provider call.
 * - `INDETERMINATE`   — the call MAY have executed (timeout after start,
 *                       dropped connection, or response received but local
 *                       processing failed); cost/accounting risk is unknown.
 *
 * Attempts are observability-only: they never carry prompts, responses, media,
 * or secrets, and they never enter the pricing engine.
 */
export type ProviderAttemptOutcome = 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';

/** A single normalized provider attempt. */
export interface ProviderAttempt {
  attemptId: string;
  provider: string;
  operation?: string;
  requestedModel?: string;
  actualModel?: string;
  /** 1-based retry position of this logical provider operation. */
  attemptNumber: number;
  outcome: ProviderAttemptOutcome;
  /** Whether the provider SDK call began (a real provider call was attempted). */
  providerCallStarted: boolean;
  /** ISO-8601 start time of the provider SDK call when one began (optional). */
  providerCallStartedAt?: string;
  providerCompletedAt?: string;
  providerResponseReceived: boolean;
  /** True only when this attempt has a linked confirmed provider usage record. */
  usageConfirmed?: boolean;
  providerCallId?: string;
  errorCategory?: string;
  httpStatus?: number;
}

/** Raw wire shape of a ProviderAttempt before normalization. */
export interface RawProviderAttempt {
  attemptId?: unknown;
  provider?: unknown;
  operation?: unknown;
  requestedModel?: unknown;
  actualModel?: unknown;
  attemptNumber?: unknown;
  outcome?: unknown;
  providerCallStarted?: unknown;
  providerCallStartedAt?: unknown;
  providerCompletedAt?: unknown;
  providerResponseReceived?: unknown;
  usageConfirmed?: unknown;
  providerCallId?: unknown;
  errorCategory?: unknown;
  httpStatus?: unknown;
  [key: string]: unknown;
}

/**
 * Billing-safety risk derived from a request's provider attempts, kept strictly
 * separate from the pricing `summaryStatus`.
 *
 * - `NONE`                    — no failed / indeterminate attempts.
 * - `FAILED_ATTEMPT_PRESENT`  — at least one confirmed FAILED attempt (the
 *                               provider rejected the call; confirmed no cost).
 * - `INDETERMINATE_COST_RISK` — at least one INDETERMINATE attempt (the call
 *                               MAY have executed with unknown cost). This is
 *                               the most conservative state and takes
 *                               precedence over `FAILED_ATTEMPT_PRESENT`.
 */
export type AttemptRiskStatus = 'NONE' | 'FAILED_ATTEMPT_PRESENT' | 'INDETERMINATE_COST_RISK';

export interface AIChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIChatUserContext {
  display_name: string;
  gender: string;
  nationality: string;
  language: unknown;
  budget_level?: string | null;
  travel_style?: string | null;
  interests?: unknown;
  accommodation_type?: string | null;
  preferences: Record<string, unknown>;
}

export interface AIChatRequest {
  message: string;
  conversation_id?: string;
  persona?: AIChatPersona;
  user?: AIChatUserContext;
  lat?: number;
  lon?: number;
  history?: AIChatHistoryMessage[];
  environment?: unknown;
  geography?: unknown;
  safety?: unknown;
  currency?: unknown;
  user_journeys?: unknown;
  conversationSummary?: string;
  maxOutputTokens?: number;
}

export interface AIChatResponse {
  response: string;
  conversation_id: string;
  persona: string;
  blocked?: boolean;
  reason?: string | null;
  environment?: unknown;
  geography?: unknown;
  safety?: unknown;
  currency?: unknown;
  user_journeys?: unknown;
  usage?: AIProviderUsage;
  providerCalls?: ProviderCallUsage[];
  providerAttempts?: ProviderAttempt[];
}

type _AssertTrue<T extends true> = T;

type _CheckHistoryOptional = _AssertTrue<
  undefined extends AIChatRequest['history'] ? true : false
>;

type _CheckConversationSummaryOptional = _AssertTrue<
  undefined extends AIChatRequest['conversationSummary'] ? true : false
>;

type _CheckMaxOutputTokensOptional = _AssertTrue<
  undefined extends AIChatRequest['maxOutputTokens'] ? true : false
>;

type _CheckUsageOptional = _AssertTrue<
  undefined extends AIChatResponse['usage'] ? true : false
>;
