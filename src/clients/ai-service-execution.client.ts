import { env } from '../config/env.js';

/**
 * Isolated HTTP transport client for the future durable non-streaming AI
 * execution path.
 *
 * Responsibilities:
 * - POST a serialized wire request to the configured AI Service endpoint.
 * - Send the shared internal API key header.
 * - Apply an explicit finite timeout.
 * - Perform exactly one fetch attempt. Never retries, never fails over.
 * - Parse the response body as unknown JSON.
 *
 * The client performs no contract parsing, no pricing, no Wallet access, no
 * Prisma access, and no persistence. It returns structured transport metadata
 * so the thin executor can classify pre-dispatch vs post-dispatch failures.
 */

export const AI_SERVICE_EXECUTION_ENDPOINT = '/v1/execute/chat';

export const AI_SERVICE_EXECUTION_DEFAULT_TIMEOUT_MS = 15_000;

export type AIExecutionTransportFailureCode =
  | 'INVALID_BASE_URL'
  | 'MISSING_INTERNAL_API_KEY'
  | 'INVALID_TIMEOUT'
  | 'REQUEST_SERIALIZATION_FAILED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'FETCH_REJECTED'
  | 'INVALID_RESPONSE_JSON';

export interface AIServiceExecutionClientDependencies {
  baseUrl?: string;
  apiKey?: string;
  endpointPath?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type AIExecutionTransportResult =
  | {
      status: 'SUCCESS';
      httpStatus: number;
      body: unknown;
    }
  | {
      status: 'FAILURE';
      code: AIExecutionTransportFailureCode;
      message: string;
      /**
       * false = proven before fetch was invoked (never dispatched),
       * true  = fetch was invoked or may have been invoked.
       */
      providerRequestSent: boolean;
    };

export async function sendAIExecutionRequest(
  body: unknown,
  dependencies: AIServiceExecutionClientDependencies = {},
): Promise<AIExecutionTransportResult> {
  const baseUrl = dependencies.baseUrl ?? env.AI_SERVICE_URL;
  const apiKey = dependencies.apiKey ?? env.INTERNAL_API_KEY;
  const endpointPath = dependencies.endpointPath ?? AI_SERVICE_EXECUTION_ENDPOINT;
  let timeoutMs: number;
  if (dependencies.timeoutMs === undefined) {
    timeoutMs = AI_SERVICE_EXECUTION_DEFAULT_TIMEOUT_MS;
  } else if (isValidTimeout(dependencies.timeoutMs)) {
    timeoutMs = dependencies.timeoutMs;
  } else {
    return failure('INVALID_TIMEOUT', 'AI service timeout is invalid', false);
  }
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;

  if (typeof baseUrl !== 'string' || !isAbsoluteHttpUrl(baseUrl)) {
    return failure('INVALID_BASE_URL', 'AI service base URL is invalid', false);
  }

  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return failure('MISSING_INTERNAL_API_KEY', 'AI service internal API key is missing', false);
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return failure(
      'REQUEST_SERIALIZATION_FAILED',
      'AI execution request could not be serialized',
      false,
    );
  }

  const url = `${baseUrl.replace(/\/+$/, '')}${
    endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`
  }`;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Api-Key': apiKey,
      },
      body: serialized,
      signal: controller.signal,
    });

    let text: string;
    try {
      text = await response.text();
    } catch {
      return failure('FETCH_REJECTED', 'AI service response could not be read', true);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return failure('INVALID_RESPONSE_JSON', 'AI service response was not valid JSON', true);
    }

    return { status: 'SUCCESS', httpStatus: response.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return failure(
        timedOut ? 'TIMEOUT' : 'ABORTED',
        timedOut ? 'AI service request timed out' : 'AI service request was aborted',
        true,
      );
    }
    return failure('FETCH_REJECTED', 'AI service request failed', true);
  } finally {
    clearTimeout(timer);
  }
}

function failure(
  code: AIExecutionTransportFailureCode,
  message: string,
  providerRequestSent: boolean,
): AIExecutionTransportResult {
  return { status: 'FAILURE', code, message, providerRequestSent };
}

function isValidTimeout(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
