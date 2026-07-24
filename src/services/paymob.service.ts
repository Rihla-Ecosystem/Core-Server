import { env } from '../config/env.js';
import { post, HttpClientError } from '../utils/http-client.js';

export interface PaymobBillingData {
  first_name: string;
  last_name: string;
  email: string;
  phone_number: string;
  apartment: string;
  floor: string;
  street: string;
  building: string;
  shipping_method: string;
  postal_code: string;
  city: string;
  country: string;
  state: string;
}

export interface PaymobItem {
  name: string;
  amount: number;
  description?: string;
  quantity: number;
}

export interface CreatePaymobIntentionInput {
  amount: number; // expected in cents
  currency: string;
  billing_data: PaymobBillingData;
  items?: PaymobItem[];
  special_reference: string;
}

export interface PaymobCreateIntentionResponse {
  id: string | number;
  client_secret: string;
}

export interface PaymobIntentionResult {
  intentionId: string;
  clientSecret: string;
  rawResponse: PaymobCreateIntentionResponse;
}

/**
 * Creates a Paymob Flash Payment Intention.
 * Expects amount in cents without converting money values internally.
 */
export async function createPaymobIntention(
  input: CreatePaymobIntentionInput,
): Promise<PaymobIntentionResult> {
  if (
    !Number.isInteger(input.amount) ||
    !Number.isSafeInteger(input.amount) ||
    input.amount <= 0
  ) {
    throw new Error('Amount must be a positive safe integer in cents');
  }

  const url = `${env.PAYMOB_API_BASE_URL}/v1/intention/`;

  const payload = {
    amount: input.amount,
    currency: input.currency,
    payment_methods: [env.PAYMOB_CARD_INTEGRATION_ID],
    billing_data: input.billing_data,
    items: input.items ?? [],
    special_reference: input.special_reference,
    redirection_url: env.PAYMOB_REDIRECTION_URL,
    notification_url: env.PAYMOB_NOTIFICATION_URL,
  };

  const headers: Record<string, string> = {
    Authorization: `Token ${env.PAYMOB_SECRET_KEY}`,
  };

  try {
    const response = await post<PaymobCreateIntentionResponse>(
      url,
      payload,
      headers,
    );

    const rawId = response?.id;
    const rawClientSecret = response?.client_secret;

    const isValidId =
      (typeof rawId === 'string' && rawId.trim().length > 0) ||
      (typeof rawId === 'number' && Number.isFinite(rawId));

    const isValidClientSecret =
      typeof rawClientSecret === 'string' && rawClientSecret.trim().length > 0;

    if (!isValidId || !isValidClientSecret) {
      throw new Error('Paymob response missing valid id or client_secret');
    }

    const intentionId = String(rawId);
    const clientSecret = rawClientSecret;

    return {
      intentionId,
      clientSecret,
      rawResponse: response,
    };
  } catch (error) {
    if (error instanceof HttpClientError) {
      let parsedBody: unknown = error.body;
      if (typeof error.body === 'string') {
        try {
          parsedBody = JSON.parse(error.body);
        } catch {
          // Keep string body
        }
      }
      throw new HttpClientError(
        error.status,
        `Paymob API error (${error.status}): Request failed`,
        parsedBody,
      );
    }
    throw error;
  }
}
