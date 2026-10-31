# Kaata Pro

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
HESABPAY_API_KEY=<existing shared merchant key>
HESABPAY_ENVIRONMENT=production
HESABPAY_WEBHOOK_TOKEN=<independent random 32-byte token>
HESABPAY_CHECKOUT_HOSTS=developers.hesab.com
HESABPAY_WEBHOOK_READY=false
```

`developers.hesab.com` was observed in a successful response from the official production create-session API. The allowlist matches exact HTTPS hosts; the client validates it too. Sandbox calls use the provider's separate official sandbox API.

Once the deployed receiver is available, register its private `https://api.kaata.af/v1/web-pro/hesabpay/webhook/<token>` URL for `payment_success` and `payment_failure` in the merchant portal. Its signed validation request must pass before setting `HESABPAY_WEBHOOK_READY=true`. The readiness flag enables creating checkouts, independently of the receiver and open workspace access. Verify the merchant's website/domain configuration when completing the provider setup.

### Existing merchant receiver

The current HesabPay merchant account permits one API key. Kaata and Kaka Malem
use the same existing merchant key, kept on their backends; coordinate any key
rotation across both applications. Kaata's private callback token remains an
independent secret. The live merchant portal also permits one receiver per event.
Moving those event URLs affects the other application using the same merchant account.
Do not replace them until the user has specifically approved the shared routing
change. The optional server-only setting below preserves verified foreign
notifications through the existing receiver; it is unset by default.

```dotenv
# Set only after approving the existing receiver's use as the relay destination.
HESABPAY_FOREIGN_WEBHOOK_URL=https://existing-merchant.example/api/webhooks/hesabpay
```

The relay destination is a fixed HTTPS DNS URL from deployment configuration,
never from a browser or callback field. Credentials, ports, literal IP addresses,
query strings, fragments and normalized self-loop callback paths are rejected.
An invalid nonempty destination disables new checkout creation and returns a
retryable error for foreign events; it never silently becomes an unset relay.

After the private callback token and HesabPay signature/timestamp checks pass,
the receiver classifies ownership from a minimal envelope. Foreign success and
failure payloads are forwarded synchronously as the original JSON bytes, up to
128 KiB, without Kaata authorization, cookies or other incoming headers. The
client validates TLS, refuses redirects and times out after five seconds. Only
the existing receiver's HTTP 200 acknowledges a foreign delivery; other statuses
and timeouts return 503 so HesabPay can retry with a fresh timestamp/signature.
There is no asynchronous replay queue for expiring signatures.

Here, unmatched means that the order ID is not present in Kaata's database. A
late notification for a deleted Kaata order also falls into that category; it
cannot recreate an account or restore its entitlement. Review this routing
boundary together with the added availability dependency before switching an
existing merchant receiver.

Kaata's known successful payments retain strict order/item/amount matching and
exactly-once fulfillment. Known Kaata failures are acknowledged locally without
downgrading a paid order. Validation probes stay local, and unverified events
never reach the other receiver. With the optional destination unset, verified
foreign events retain the original acknowledge-without-forwarding behavior.

The backend logger redacts the callback token. Proxies and external request logs must also keep that private path confidential. Never add the merchant key or callback token to a tracked file, frontend build argument, browser storage or public environment variable.

### Production routing

On 31 October 2026, both production HesabPay events were moved to Kaata's private
receiver after approval of the shared routing. Both provider validation requests
returned HTTP 200. Forwarding was applied and verified in the healthy runtime
before either event moved; a credential-free HTTPS request from that container
to Kaka Malem's existing receiver returned HTTP 200 in under one second with
certificate verification enabled. Checkout readiness was then enabled in both
the encrypted deployment configuration and running service. Web access remains
`trial_open` for every account.

Kaka Malem uses the same existing merchant key. Its timestamp window now matches
Kaata: ten minutes old and one minute ahead. Its PostgreSQL 16 compatibility fix
and migration 0053 are deployed, and the invoice timer below is active. These
validation and network checks do not establish a completed real payment or an
actual foreign payment notification passing through the relay.

For rollback, disable new checkout creation first. Keep forwarding configured
while either provider event still points to Kaata: an unset relay acknowledges
unmatched notifications without forwarding. Restore both existing Kaka Malem
receiver URLs before removing the relay destination.

### Production domain ownership

On 31 October 2026, `kaata.af` and `kakamalem.com` were verified and enabled in
HesabPay's production registered domains. Each Cloudflare zone retains its
public `_hesabpay-prod` TXT ownership proof. The same existing merchant API key
remains unchanged. Kaka Malem remains Primary as a management preference; it
does not restrict the shared key to that website. Existing website and email
routing records were preserved.

Both payment receiver checks were refreshed after verification and returned
HTTP 200 with the existing shared receiver URLs.

Keep both TXT records for future manual ownership rechecks. Follow the official
[domain verification guide](https://docs.hesab.com/quickstart/domain-verification/)
when maintaining registrations or replacing an expired challenge.

### Shared VPS invoice worker

Kaka Malem's subscription invoice queue runs every minute through the host's
`kakamalem-subscription-invoices.timer` and matching oneshot service. The runner
at `/usr/local/libexec/kakamalem-subscription-invoices.py` discovers the current
healthy Kaka Malem container and invokes its invoice endpoint over container-local
HTTP. It reads the existing `CRON_SECRET` inside that container; the host files
contain no copied credential. A deployment does not require changing a container
ID in the schedule. Systemd prevents overlapping host runs, and the application
also locks invoice jobs across replicas. Check the service result and queue age
when investigating delayed receipts. This schedule processes invoice PDFs and
emails; payment recording and subscription activation happen in the webhook.

## Verification

Web client tests cover authenticated account scope, request identity, fixed prices, unsafe checkout URLs, malformed responses and untrusted return data. Backend tests use disposable PostgreSQL and a simulated provider to cover binding, concurrent reservations and renewals, replay, failed and delayed payments, receiver probes, account isolation, and calendar boundaries. A production setup checkout validated the supplied key and actual checkout hostname without making a payment. A receiver-validation check verifies delivery setup, not a completed payment.

This release passed all 271 web tests across 27 files, nine privacy/metadata checks, the production TypeScript/Vite build, nine Web Pro tests with real disposable PostgreSQL, the full backend auth suite, HTTP middleware tests and server compilation. Browser QA with sample records verified optional trial access during billing setup/outage, preserved note drafts, the yearly checkout and origin-only link, explicit expired-payment review, a paid receipt alongside an older pending payment, and the 390px Dari layout. Test services and the temporary PostgreSQL cluster were stopped and removed after verification.

The optional shared-receiver relay update passed all 15 Web Pro tests, including
six new TLS relay tests, real disposable PostgreSQL lifecycle checks, HTTP
middleware tests and server compilation. Coverage includes untouched legacy
success/failure JSON, header isolation, body limits, verification before
forwarding, local probes, normalized self-loop rejection, redirect refusal,
200-only acknowledgement, timeout retries and no forwarding of known Kaata
paid/replayed/tampered/failed orders. Its temporary PostgreSQL instance was
stopped and its data removed. These checks do not switch merchant receivers or
authorize forwarding in production. The subsequent approved production cutover
and its live checks are recorded above.
