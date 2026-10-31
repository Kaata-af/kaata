# Kaata Web Pro

Kaata Web is an open free trial. Every account keeps all existing workspace access, whether it has paid, has an expired subscription, cannot reach billing, or has a payment still being confirmed. There is no trial deadline or Pro authorization middleware. Mobile access and mobile subscriptions are unchanged.

Pro belongs to the signed-in account and covers its web workspace. The approved prices are **200 AFN for one month** and **2,000 AFN for twelve months**. These are prepaid periods with manual renewal, not recurring deductions. Ledger currencies do not change the AFN subscription price.

The workspace banner links to authenticated `/app/subscription`. Its route dialog preserves the mounted workspace and open drafts. English, Dari and Pashto show the plans, open-trial status, checkout setup or errors, and server-confirmed subscription expiry.

## Payment flow

- Authenticated `GET /v1/web-pro` returns the open-trial access policy, current subscription, fixed plans, checkout availability, exact allowed checkout hosts and any unresolved order ID.
- `POST /v1/web-pro/checkout` accepts a server-known plan and a client request UUID. The server snapshots the price and period. An account lock prevents concurrent tabs from opening separate live checkouts. Reusing a request UUID never creates another provider session.
- The server calls HesabPay's hosted-checkout API. The API key stays on the backend. The browser receives only the checkout link and order ID. The checkout anchor sends an origin-only referrer, preserving private page paths and the existing authentication-page referrer policy.
- Return URLs retain the validated initiating site origin. The configured Kaata origin and its supported `www` equivalent are accepted; arbitrary return destinations are rejected. Browser return data never grants Pro.
- Authenticated `GET /v1/web-pro/orders/{id}` reads only the current account's order. The UI clears provider return parameters and checks this server record. A checkout-link expiry does not prove payment failed. An explicit new checkout after expiry requires reviewing the unresolved payment first; late verified payments remain fulfillable.
- Verified payment notifications update the order and subscription atomically. Globally unique transaction IDs and paid-order checks prevent replay from adding time twice. Renewals extend from the later of the current expiry or the server time, using UTC calendar months with month-end clamping.

HesabPay's published signature verifier accepts a signature and timestamp, without documenting binding to the complete event body. The receiver therefore also requires an independent high-entropy token in its private callback path. After provider verification, it matches the stored random order ID, item ID/name, exact AFN amount and successful-payment fields. Receiver-validation probes never grant subscriptions. Verified notifications for another application are acknowledged without changing Kaata records. Payment failures cannot downgrade a paid order.

See the official [checkout API](https://docs.hesab.com/api-reference/create-payment-session/), [payment-result guide](https://docs.hesab.com/quickstart/handle-result/), [webhook guide](https://docs.hesab.com/webhooks/overview/), and [signature verifier](https://docs.hesab.com/webhooks/verify-signatures/). The extra callback-token check is Kaata's defensive design, rather than an assertion that the provider signs every payload field.

## Deployment

Migration `076_web_pro.sql` adds account subscriptions and checkout orders. Deploy the backend before enabling checkout; a missing billing API never blocks the workspace.

Configure these backend settings through the existing deployment secret configuration:

```dotenv
HESABPAY_API_KEY=<dedicated merchant key>
HESABPAY_ENVIRONMENT=production
HESABPAY_WEBHOOK_TOKEN=<independent random 32-byte token>
HESABPAY_CHECKOUT_HOSTS=developers.hesab.com
HESABPAY_WEBHOOK_READY=false
```

`developers.hesab.com` was observed in a successful response from the official production create-session API. The allowlist matches exact HTTPS hosts; the client validates it too. Sandbox calls use the provider's separate official sandbox API.

Once the deployed receiver is available, register its private `https://api.kaata.af/v1/web-pro/hesabpay/webhook/<token>` URL for `payment_success` and `payment_failure` in the merchant portal. Keep existing receivers intact. Its signed validation request must pass before setting `HESABPAY_WEBHOOK_READY=true`. The readiness flag enables creating checkouts, independently of the receiver and open workspace access. Verify the merchant's website/domain configuration when completing the provider setup.

The backend logger redacts the callback token. Proxies and external request logs must also keep that private path confidential. Never add the merchant key or callback token to a tracked file, frontend build argument, browser storage or public environment variable.

## Verification

Web client tests cover authenticated account scope, request identity, fixed prices, unsafe checkout URLs, malformed responses and untrusted return data. Backend tests use disposable PostgreSQL and a simulated provider to cover binding, concurrent reservations and renewals, replay, failed and delayed payments, receiver probes, account isolation, and calendar boundaries. A production setup checkout validated the supplied key and actual checkout hostname without making a payment. A receiver-validation check verifies delivery setup, not a completed payment.

This release passed all 271 web tests across 27 files, nine privacy/metadata checks, the production TypeScript/Vite build, nine Web Pro tests with real disposable PostgreSQL, the full backend auth suite, HTTP middleware tests and server compilation. Browser QA with sample records verified optional trial access during billing setup/outage, preserved note drafts, the yearly checkout and origin-only link, explicit expired-payment review, a paid receipt alongside an older pending payment, and the 390px Dari layout. Test services and the temporary PostgreSQL cluster were stopped and removed after verification.
