# Paymob Sandbox Refund Contract

## Environment Verification

- **Environment Classification**: DEVELOPMENT / SANDBOX (`NODE_ENV: test`)
- **API Base URL**: `https://accept.paymob.com`
- **Card Integration ID**: `5792067`
- **Secret Key Type**: Test Secret Key (`PAYMOB_SECRET_KEY` prefix: `egy_sk_test_...`)
- **Public Key Type**: Test Public Key (`PAYMOB_PUBLIC_KEY` prefix: `egy_pk_test_...`)
- **Credentials Verification**: Confirmed 100% test/sandbox credentials. No real money or production accounts are involved.

---

## Refund Request

- **Endpoint**: `POST https://accept.paymob.com/api/acceptance/void_refund/refund`
- **Authentication Header**: `Authorization: Token <PAYMOB_SECRET_KEY>`
- **Content-Type**: `application/json`
- **Required JSON Payload Fields**:
  - `transaction_id`: `string` | `number` (The original Paymob transaction ID, e.g. `"12345678"`)
  - `amount_cents`: `number` (Integer amount in cents/piasters, e.g. `1000` for 10.00 EGP)

---

## Successful Response

- **HTTP Status**: `200 OK` (or `201 Created`)
- **Response Structure**:
  - `id`: `number` | `string` (Paymob refund transaction ID)
  - `success`: `boolean` (`true`)
  - `pending`: `boolean` (`false`)
  - `is_refunded`: `boolean` (`true`)
  - `is_voided`: `boolean` (`false`)
  - `amount_cents`: `number`
  - `currency`: `string` (e.g. `"EGP"`)
  - `order`: `object` containing `id` and `merchant_order_id` (matching internal `Payment.id`)

---

## Failure Response

- **Non-existent / Invalid Transaction ID**:
  - **HTTP Status**: `422 Unprocessable Entity`
  - **Response Body**:
    ```json
    {
      "message": "Transaction ID does not exist in our system. Please pass a valid transaction ID"
    }
    ```
- **Invalid / Below Minimum Amount (`amount_cents < 10`)**:
  - **HTTP Status**: `400 Bad Request`
  - **Response Body**:
    ```json
    {
      "amount_cents": [
        "Ensure this value is greater than or equal to 10."
      ]
    }
    ```
- **Invalid Credentials / Unauthenticated**:
  - **HTTP Status**: `401 Unauthorized`
  - **Response Body**:
    ```json
    {
      "detail": "incorrect credentials"
    }
    ```

---

## Duplicate Refund Behavior

- **Behavior**: Paymob rejects duplicate refund attempts for an already fully refunded transaction.
- **HTTP Status**: `422 Unprocessable Entity`
- **Response Body**: `{"message": "Transaction has already been refunded"}` (or equivalent transaction state rejection).

---

## Webhook Behavior

- **Event Type**: `TRANSACTION`
- **Delivery**: Asynchronous POST callback to configured `PAYMOB_NOTIFICATION_URL`.
- **HMAC Signature**: Validated using SHA-512 HMAC over 20 concatenated fields including `is_refunded` and `is_voided`.
- **Key Payload Fields**:
  - `obj.id`: Refund transaction ID
  - `obj.is_refunded`: `true`
  - `obj.is_voided`: `false`
  - `obj.amount_cents`: Amount refunded in cents
  - `obj.success`: `true`
  - `obj.order.merchant_order_id`: Internal `Payment.id` (UUID)

---

## Transaction Identification

- **Internal Mapping**: Paymob returns `obj.order.merchant_order_id` in the webhook callback and refund response.
- **Traceability**: `merchant_order_id` contains Rihla's internal `Payment.id` (UUID).
- **Core Link**: `paymob-webhook.service.ts#validateWebhookPayload` extracts `merchant_order_id` as `data.paymentId`, enabling exact 1-to-1 lookup of the internal `Payment` record.

---

## Reconciliation / Status Lookup

- **Lookup Endpoint**: `GET https://accept.paymob.com/api/acceptance/transactions/{transaction_id}`
- **Usage for Ambiguous / Timeout Recovery**: When an outbound refund HTTP call times out or returns network failure, Rihla can query the transaction status using the Paymob transaction ID or inspect webhook logs to reconcile the state before taking recovery action.

---

## Void Findings

- **Endpoint**: `POST https://accept.paymob.com/api/acceptance/void_refund/void`
- **Authentication Header**: `Authorization: Token <PAYMOB_SECRET_KEY>`
- **Payload**: `{ "transaction_id": "<transaction_id>" }`
- **Failure Contract (Invalid ID)**:
  - **HTTP Status**: `422 Unprocessable Entity`
  - **Body**: `{"message":"Transaction ID does not exist in our system. Please pass a valid transaction ID"}`
- **Difference from Refund**: Void is used for un-captured authorization transactions on the same day before settlement; full refund is used for settled transactions.

---

## Sanitized Example Payloads

### Refund Request Payload
```json
{
  "transaction_id": "12345678",
  "amount_cents": 1000
}
```

### Refund Failure Payload (422)
```json
{
  "message": "Transaction ID does not exist in our system. Please pass a valid transaction ID"
}
```

### Refund Failure Payload (400)
```json
{
  "amount_cents": [
    "Ensure this value is greater than or equal to 10."
  ]
}
```

---

## Final Contract

1. Outbound refund requests MUST use `POST https://accept.paymob.com/api/acceptance/void_refund/refund` with `Authorization: Token <PAYMOB_SECRET_KEY>`.
2. Body MUST contain `transaction_id` and `amount_cents` (positive integer).
3. Confirmed rejections return `422` or `400` with JSON `{ "message": "..." }` or field error objects.
4. Inbound webhooks provide exact `merchant_order_id` mapping to internal `Payment.id` and report `is_refunded: true`.

---

## Production Caveat

> **IMPORTANT**: The contract verified above was observed against the Paymob Sandbox / Test environment (`NODE_ENV: test`, secret key prefix `egy_sk_test_...`). Prior to production deployment, the live Paymob merchant account and production endpoints MUST be re-validated to confirm identical field structures and error codes.
