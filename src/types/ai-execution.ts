import type { AIProviderUsage, AIChatHistoryMessage } from './ai.js';

/**
 * Provider-neutral execution request between the Core Server and the external
 * AI Service.
 *
 * Provider/model are optional at this generic level until production routing is
 * finalized. This contract never carries API keys, pricing information, Wallet
 * balances, or provider-specific request fields.
 */
export interface AIExecutionRequest {
  operationId: string;
  feature: string;

  provider?: string;
  model?: string;

  input: {
    message: string;
    history?: AIChatHistoryMessage[];
    context?: string;
  };

  limits: {
    maxInputTokens: number;
    maxOutputTokens: number;
  };

  metadata?: {
    userId?: string;
    conversationId?: string;
    requestId?: string;
  };
}

/**
 * Actual execution identity returned by the AI Service after execution.
 * Represents what was actually executed, not merely what Core requested.
 */
export interface AIExecutionIdentity {
  provider: string;
  model: string;
  providerRequestId?: string;
}

/**
 * Success outcome. `execution` and `usage` are always required and must agree
 * on provider/model after trimming. Cost is never calculated in this layer.
 */
export interface AIExecutionSuccess<TData = unknown> {
  kind: 'SUCCESS';
  data: TData;
  execution: AIExecutionIdentity;
  usage: AIProviderUsage;
}

/**
 * Failure confirmed to have happened before the provider request was sent.
 * No provider execution cost is expected and the billing orchestrator may
 * release the reservation.
 */
export interface AIExecutionNonBillableFailure {
  kind: 'NON_BILLABLE_FAILURE';
  code: string;
  message: string;
  providerRequestSent: false;
  retryable: boolean;
}

/**
 * Failure after the provider request was sent or may have been sent. Provider
 * execution cost cannot be safely determined and the billing orchestrator must
 * not automatically release the reservation.
 */
export interface AIExecutionIndeterminateFailure {
  kind: 'INDETERMINATE_FAILURE';
  code: string;
  message: string;
  providerRequestSent: true;
  retryable: boolean;
  execution?: Partial<AIExecutionIdentity>;
}

export type AIExecutionOutcome<TData = unknown> =
  | AIExecutionSuccess<TData>
  | AIExecutionNonBillableFailure
  | AIExecutionIndeterminateFailure;

/**
 * Provider-neutral streaming event union. Only the event types are defined
 * here; no stream state machine is implemented in this step.
 *
 * - DELTA never contains usage; usage must be delivered through USAGE.
 * - USAGE carries the actual provider/model.
 * - DONE does not imply usage was received.
 * - An interrupted stream without trusted USAGE remains indeterminate.
 */
export type AIExecutionStreamEvent =
  | {
      type: 'START';
      operationId: string;
      execution?: Partial<AIExecutionIdentity>;
    }
  | {
      type: 'DELTA';
      text: string;
    }
  | {
      type: 'USAGE';
      execution: AIExecutionIdentity;
      usage: AIProviderUsage;
    }
  | {
      type: 'DONE';
    }
  | {
      type: 'FAILURE';
      failure: AIExecutionNonBillableFailure | AIExecutionIndeterminateFailure;
    };
