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
