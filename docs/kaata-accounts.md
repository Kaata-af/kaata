# Kaata accounts: email + password

Status: accounts were submitted in 2.1.1 (Android build 50 / iOS build 30).
The display-name and current-member-profile extensions below are local development
after 2.2.0 TestFlight build 32 / Play internal code 52; those binaries do not
contain the extensions. Owner decisions (Matee, 2026-10-10):

- Kaata has its own accounts for everyone, next to Google and Apple: sign up with
  email + password; the email is verified with an emailed 6-digit code.
- Sign-up asks for email and password only. A username is optional, added in Account
  settings, and then also works for sign-in ("email or username + password").
- It ships in this release. Play's reviewers use an ordinary email account. The
  unshipped review-only login (REVIEW*LOGIN*\*, POST /v1/auth/review, provider
  'review', scripts/review-login.mjs) is removed.
- It must be tight: a trust/score system may later rank users.

This document is the contract for the build. Three independent reviews of draft 1
shaped it, and a final review of the built code (2026-10-10) added the hardening in
§2 (migration 053) and §4-§6; their fixes are folded in below. Section 11 lists what
is deferred and the residual risks we accepted.

## 1. Principles

1. **A signed-out flow never adds a password to an existing account.** Sign-up only
   creates accounts. Reset only works for accounts that already have a password. A
   Google or Apple account gets a first password only while signed in to it, through
   a code sent to an address the user proves.
2. **Every flow answers the same way whether or not an account exists**, and every
   throttle counts requests, not outcomes.
3. **One live session credential per install.** Any sign-in replaces every other
   credential on that install; sign-out removes all of them.
4. **The server decides "different account on this phone"** for all three providers,
   before anything is written.
5. **Secrets never reach logs**: no passwords, codes, email addresses or identifiers,
   on success or failure. Logs carry error codes, status and install id only.
6. **A verified email proves mailbox control, not personhood.** A future trust score
   keys on account_id plus stronger signals, never on emails, names or usernames.

## 2. Data model: migration `052_email_accounts.sql`

The unshipped `052_auth_credentials_provider_review.sql` is deleted; this file takes 052. It starts by removing any provider rows a dev database may hold from the review
login, so the new CHECK can be added.

```sql
DELETE FROM auth_credentials WHERE provider NOT IN ('google', 'apple', 'email');
ALTER TABLE auth_credentials DROP CONSTRAINT IF EXISTS auth_credentials_provider_check;
ALTER TABLE auth_credentials ADD CONSTRAINT auth_credentials_provider_check
  CHECK (provider IN ('google', 'apple', 'email'));

-- Optional private sign-in handle. Stored canonical (lowercase). Never shown to
-- other users, never in tab/inbox/invite/bill payloads, never a trust key.
ALTER TABLE accounts ADD COLUMN username TEXT;
CREATE UNIQUE INDEX accounts_username_key ON accounts (username) WHERE username IS NOT NULL;
ALTER TABLE accounts ADD CONSTRAINT accounts_username_format
  CHECK (username IS NULL OR username ~ '^[a-z][a-z0-9_.]{2,29}$');

CREATE TABLE account_passwords (
  account_id    UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,        -- PHC string, argon2id
  norm_version  SMALLINT NOT NULL,    -- password canonicalization version (§3)
  login_email   TEXT NOT NULL,        -- the proven sign-in address, as typed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Emailed one-time codes. Only an HMAC of each code is stored.
CREATE TABLE email_codes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose             TEXT NOT NULL CHECK (purpose IN ('signup', 'reset', 'setup')),
  email               TEXT NOT NULL,   -- as typed, for display and delivery
  email_key           TEXT NOT NULL,   -- dedupe key (§4)
  account_id          UUID REFERENCES accounts(id) ON DELETE CASCADE, -- reset/setup target
  code_hash           BYTEA NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  consumed_by_install UUID
);
CREATE INDEX idx_email_codes_key ON email_codes (email_key, purpose, created_at DESC);

-- Request/failure ledger for throttles. Rows carry no plaintext identifier.
CREATE TABLE auth_throttle_events (
  id         BIGSERIAL PRIMARY KEY,
  scope      TEXT NOT NULL,           -- 'mail' | 'code_fail' | 'login'
  key        BYTEA NOT NULL,          -- HMAC(server key, scope || identifier)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_auth_throttle ON auth_throttle_events (scope, key, created_at DESC);

-- Outgoing mail, written in the same transaction as the code it carries. Bodies are
-- cleared once sent; rows are purged after 2 days.
CREATE TABLE email_outbox (
  id              BIGSERIAL PRIMARY KEY,
  to_addr         TEXT NOT NULL,
  subject         TEXT NOT NULL,
  text_body       TEXT,
  html_body       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  not_after       TIMESTAMPTZ NOT NULL,  -- give up after this (codes expire)
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  last_error      TEXT
);
CREATE INDEX idx_email_outbox_due ON email_outbox (next_attempt_at) WHERE sent_at IS NULL;
```

Migration `053_email_accounts_hardening.sql` (the final review):

```sql
-- The language a code's mail went out in; the verify's security notice follows it.
ALTER TABLE email_codes ADD COLUMN lang TEXT NOT NULL DEFAULT 'en';

-- Session epochs (§6): every sign-in gives the install's credential a fresh random
-- epoch, carried in the JWT as `ep`, so copies of an older JWT of that install stop
-- working. Legacy rows and legacy JWTs are epoch 0 and match until the next sign-in.
ALTER TABLE auth_credentials ADD COLUMN session_epoch BIGINT NOT NULL DEFAULT 0;

-- Principle 3 for rows written before it held: an install bound to one account keeps
-- no live credential of another (legacy NULL-account rows are left alone).
DELETE FROM auth_credentials ac USING installs i
WHERE ac.install_id = i.install_id AND i.account_id IS NOT NULL
  AND ac.account_id <> i.account_id;

-- The §4 dedupe key in SQL, so a Google or Apple account is found by its verified
-- email with the same rules as an 'email' identity (TestEmailKeySQLMatchesGo).
CREATE FUNCTION kaata_email_key(raw TEXT) RETURNS TEXT ... IMMUTABLE ...;
CREATE INDEX accounts_email_key_idx ON accounts (kaata_email_key(email)) WHERE email_verified;
```

- The password sign-in identity is `account_identities ('email', email_key)`. Its
  primary key makes "one password account per mailbox" a database guarantee.
- Deleting an account removes its password, codes and 'email' identity by cascade.
- The existing 24 h housekeeping pass purges `email_codes` older than 7 days,
  `auth_throttle_events` older than 2 days and `email_outbox` rows older than 2 days.

## 3. Passwords

- **Canonicalization (norm_version 1)**, applied before the policy check, hashing and
  every verify: Unicode NFKC; Persian (U+06F0-06F9) and Arabic-Indic (U+0660-0669)
  digits folded to ASCII; Arabic yeh/alef maksura (U+064A, U+0649) to Persian yeh
  (U+06CC) and Arabic kaf (U+0643) to Persian kaf (U+06A9); ZWNJ, ZWJ and bidi
  controls removed. So the same visible password works from any keyboard.
- **Policy** (server authoritative; the app mirrors it for instant feedback):
  8-128 characters after canonicalization; no leading or trailing whitespace when
  set (sign-in trims, so a pasted password with a stray space still works); not all
  digits unless at least 12 long; no run of 6+ repeated or sequential characters; not
  containing the account's phone digits when known, nor the email's local part or the
  username; not in the embedded common-password list (common passwords plus local
  terms such as kaata, kabul, afghanistan, keyboard walks). Reasons returned:
  `too_short`, `too_long`, `whitespace`, `common`, `personal`, `pattern`.
- **Hashing**: argon2id, m=19456 KiB, t=2, p=1, 16-byte salt, 32-byte key, PHC string.
  Params are read from the stored string, so they can be raised later; a sign-in with
  older params rehashes. A semaphore caps concurrent hashes at 4, acquired with a 3 s
  timeout (else 503 `busy`). Hashing never runs inside a DB transaction or while a
  pooled connection is held. After verifying, the write transaction re-reads the
  stored hash and proceeds only if it is unchanged.
- Unknown identifiers are verified against a fixed dummy hash, built once without the
  semaphore (so it can never be missing), and they wait for a hashing slot exactly as
  known ones do: under load both answer 503 `busy`, so timing and answers are uniform.

## 4. Email addresses and codes

- **Accepted addresses**: ASCII only, `net/mail.ParseAddress(s).Address == s` (no
  display name, comment or quotes), at most 254 characters, local part at most 64, a
  domain with a dot and no IP literal; Persian digits folded first. Rejected:
  `@privaterelay.appleid.com` (Apple relay addresses cannot be typed by the user) and
  an embedded list of disposable-mail domains. Reasons: `format`, `relay`,
  `disposable`.
- **Dedupe key** (`email_key`): lowercase; the `+tag` stripped on every domain; for
  gmail.com/googlemail.com dots removed and the domain unified to gmail.com. One
  'email' identity per key. The address as typed is kept for display and delivery.
  The existing `normalizeEmail` is unchanged (existing rows depend on it).
- **Codes**: 6 digits from crypto/rand; stored as HMAC-SHA256 with a key derived from
  the session secret (`HMAC(SHA256("kaata-email-code-v1" || secret), code_id || code)`);
  TTL 15 minutes. Input is digit-folded and must be exactly 6 digits after removing
  spaces and dashes, else 400 `invalid_code_format` with no attempt used.
- **Verification** checks the newest 3 live codes for (email_key, purpose), so a
  resend never kills a code that is already on its way. Each attempt is claimed
  atomically before comparing (`UPDATE ... SET attempts = attempts + 1 WHERE ...
attempts < 5 ... RETURNING`), and the code is consumed with a compare-and-set
  (`WHERE consumed_at IS NULL`) as the first write of the transaction.
- **Throttles** (`auth_throttle_events`, HMAC-keyed). Every limit counts the
  requests it ADMITS, whatever they led to, and refuses without recording; a refusal
  reports the LONGEST wait among the full windows, so `retry_after_s` is exact, and a
  known and an unknown address or identifier are throttled identically. Each
  check-then-record runs under `pg_advisory_xact_lock` on its key, so bursts cannot
  race it.
  - A start request (sign-up, reset, set-password) is admitted in one short
    transaction of its own, BEFORE the address is looked up, by three budgets in this
    order. The **client** (the IP, an IPv6 address by its /64, for the public starts;
    the account for set-password): 10 per hour, 30 per 24 h → 429 `rate_limited` +
    `retry_after_s`; loose enough for a carrier's shared (CGNAT) address. The client
    IP is the rightmost `X-Forwarded-For` address that is not Cloudflare or internal,
    else `CF-Connecting-IP` when the last hop was Cloudflare (`httpx.ClientIP`), never
    an address the client wrote. The **address**, across every purpose and notice: 1
    per minute, 5 per hour, 10 per 24 h → 429 `too_many_requests` + `retry_after_s` +
    `limit`. The **global** mail budget, `MAIL_MAX_PER_HOUR` (default 200) and
    `MAIL_MAX_PER_DAY` (default 1000), counts every mail: admitted starts and security
    notices. Sign-up may use only 80% of it, so a sign-up flood cannot starve password
    recovery → 503 `email_unavailable` and a logged alert. Because admission precedes
    the lookup, every address gets the same answer even when the budget is spent, and
    one client cannot spend it alone.
  - Security notices (password set, changed, reset or removed) are coalesced per
    recipient and kind: at most one per 10 minutes and 6 a day, and only while the
    global budget has room. A skipped notice never fails the flow that sent it.
  - Failed code checks per address across all codes: 10 per 24 h, then 429
    `too_many_attempts` for the rest of the window. A set-password check counts
    against the account AND against the address of every live code it compared.
  - Password sign-in attempts per identifier and password-change attempts per
    account: 10 per 15 minutes (§6).

## 5. Mail delivery

- Package `internal/mail`: a `Sender` interface, an SMTP sender (STARTTLS on 587 or
  implicit TLS on 465, PLAIN auth, 15 s timeout, headers built with
  `net/mail.Address` and MIME encoding, never by concatenation) and a log sender.
- **Driver choice is explicit**: `MAIL_DRIVER=smtp` with `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USERNAME`, `SMTP_PASSWORD`, `MAIL_FROM`; or `MAIL_DRIVER=log`, which prints
  messages (codes included) and is allowed only with `KAATA_ENV=development`
  (fail-closed: anywhere else it stops the boot). An `SMTP_*` value that still holds a
  `<placeholder>` counts as empty. Anything else disables mail: code endpoints answer
  503 `email_unavailable`, password sign-in still works. Boot logs which driver is
  active (never the credentials).
- **Health**: the boot SMTP login check, and any later delivery that fails to log in,
  turn email off (start endpoints answer 503 `email_unavailable` instead of a "sent"
  that never arrives) until a re-check every 60 s logs in again.
- **Outbox**: every mail is a row in `email_outbox`, written in the same transaction
  as its code. Two worker goroutines send due rows (polling every 2 s plus a nudge on
  insert), retry with backoff until `not_after` (15 minutes for codes), clear the
  bodies after sending, and survive redeploys because the row persists. A claimed row
  is leased for 60 s, longer than one SMTP delivery, so a slow send is never sent
  twice; the post-send bookkeeping survives shutdown, and the server waits briefly for
  deliveries in flight before it exits.
- **Templates** (en and fa from the request's `lang`): plain text + minimal HTML. The
  code is never in the subject. The body opens with a sentence, then the code in
  ASCII digits (LTR-isolated in fa), then "It expires in 15 minutes. Never share this
  code with anyone. If you didn't ask for it, ignore this email." No
  user-supplied text in any mail.
- Kinds: sign-up code; reset code; set-password code; "you already have a Kaata
  account" notice (sign-up for a taken address); "this account signs in with Google
  or Apple" notice (sign-up or reset for an account without a password); "this
  account's password signs in with another address" notice, naming it masked
  (sign-up or reset for a Google/Apple account whose password uses a different
  address); security notice after a password is set, changed or reset ("If this
  wasn't you, reset your password"); "password sign-in removed" notice.
- **Provider**: Resend, with SPF, DKIM and DMARC aligned on the sending subdomain
  `mail.kaata.af`. A personal Gmail is not acceptable as
  the sender (DMARC alignment, sending caps).

## 6. API

JSON bodies, `http.MaxBytesReader` 8 KiB, per-IP rate limits sized like Google
sign-in (60/h for sign-in and verify, 30/h for start endpoints) on top of the §4
budgets. Errors use `httpx.ErrorCode` with these error codes.

**Sessions.** The JWT carries `ep`, its credential's epoch. Every sign-in gives the
install's credential a fresh random epoch, so older JWTs of that install (and copies
of them) stop authorizing; `/v1/check-in` refreshes keep the epoch. On session
routes a 401 means only that the session ended: a wrong code there is 400
`invalid_code`, a wrong current password 403 `wrong_password`.

Every endpoint that signs in returns the existing shape `{session_jwt, account_id,
default_vault_id, user}`. `user` gains `username` (omitted when none) and
`has_password` for every provider. For email sessions `user.sub` is omitted and the
JWT provider_sub is the account id, never the address.

### Shared sign-in tail (`completeSignIn`, used by Google, Apple and every email flow)

Inside the sign-in transaction, after the account is resolved:

1. lock the account row first (the same order as DeleteAccount);
2. refuse an account with `disabled_at` set (403 `account_disabled`);
3. `ensureSignInInstall` → 410 for a retired install (checked BEFORE step 4);
4. **different account**: if the request carries `current_account_id`, it differs
   from the resolved account and `allow_switch` is not true → roll back everything
   and answer 409 `different_account` with `email` (the resolved account's display
   email). Nothing is written: no account, no link, no code consumed;
5. delete every other credential of this install (any provider, any account) and
   invalidate the session cache for the install;
6. bind `installs.account_id`, upsert the credential, read the default vault, commit,
   sign the JWT.

`/v1/auth/google` and `/v1/auth/apple` accept `current_account_id` and `allow_switch`
too. `POST /v1/auth/signout` deletes every credential of the install. The push
validity gate (`internal/tabs/push.go`) additionally requires the credential's
`revoked_at IS NULL`.

### Public endpoints

1. `POST /v1/auth/email/signup/start {email, lang}` → `200 {status:"sent",
resend_after_s:60}`; 400 `invalid_email` + `reason`; 429; 503. If any account owns
   the address (an 'email' identity with this key, or an account with identities whose
   verified email has this key), a notice is sent instead of a code: "you already have
   an account", "signs in with Google or Apple", or "password uses another address".
   The response is identical. 429 `rate_limited` / `too_many_requests` and 503 come
   from the §4 admission, before the lookup.
2. `POST /v1/auth/email/signup/verify {install_id, email, code, password, lang,
current_account_id?, allow_switch?}` → 200 session. Password policy and code
   format are checked first (400 `weak_password` + reason, `invalid_code_format`; no
   attempt used). 401 `invalid_code`. Create-only: if an account owns the address by
   now, 409 `account_exists`. Creates the account (email, email_verified=true, no
   name), the 'email' identity and the password, then the shared tail.
3. `POST /v1/auth/email/signin {install_id, identifier, password,
current_account_id?, allow_switch?}` → 200 session or 401 `invalid_credentials`.
   A leading "@" is dropped (people type their handle that way); an identifier that
   still contains "@" is looked up by email_key, otherwise as a username. The
   throttle key is HMAC(identifier), so known and unknown identifiers behave
   identically: each admitted attempt is recorded before verifying; once 10 are
   inside the last 15 minutes, further attempts are refused without being recorded,
   429 `too_many_attempts` + `retry_after_s` (when the oldest leaves the window);
   success clears the identifier's entries. Sign-in reads the account with a plain lookup: no resolveOrCreateAccount,
   no adoption, no `verified_at` stamp.
4. `POST /v1/auth/email/reset/start {email, lang}` → always `200 {status:"sent"}`
   (400/429/503 as above). A reset code goes only to an account that already has a
   password, at its proven sign-in address. An account that signs in only with
   Google or Apple gets the "this account signs in with Google or Apple" notice; a
   Google/Apple account whose password uses another address gets the "password uses
   another address" notice, so the owner learns where reset codes go. Unknown
   address: nothing is sent.
5. `POST /v1/auth/email/reset/verify {install_id, email, code, new_password, lang?,
current_account_id?, allow_switch?}` → 200 session. Replaces the hash, deletes
   EVERY other credential of the account (all installs, all providers), invalidates
   the cache, clears the login throttle, queues the security notice (in `lang`, else
   the language the code was mailed in), then the shared tail, whose fresh epoch also
   ends any copied JWT of this install.

Retry safety (the app retries once on a timeout): a verify whose code was consumed
by the same install within the last 15 minutes, with a password that verifies against
the account's current hash, answers 200 with a fresh session and writes nothing else.

### Session endpoints

6. `GET /v1/account/me` → `{email, login_email, username, has_password,
providers: ["google","apple","email"...], name, setup_email}`. `setup_email` is the
   address a first-password code goes to (omitted when the user must name one,
   including when another account already signs in with the account's email).
7. `POST /v1/account/password/setup/start {email?, lang}`: first password for a
   Google/Apple account. When the account's own email is usable (valid, not an Apple
   relay, not disposable, and no other account signs in with it) the code ALWAYS goes
   there, so a session thief cannot attach an address they control; `email` is then
   optional and must name that same mailbox (409 `email_fixed` otherwise). Another
   account that merely shares that verified email (a duplicate from before accounts
   were linked) does not block it. Only an account whose email is unusable names the
   address (400 `email_required` without one), and it must not belong to another
   account (409 `email_in_use`, counted against the address budget like any start).
   409 `password_exists` if the account has one. 200 `{status:"sent"}`.
8. `POST /v1/account/password/setup/verify {code, new_password, lang?}` → `200
{has_password:true, login_email}`; a wrong or expired code is 400 `invalid_code`.
   Creates the 'email' identity for THIS account and the password; queues the
   security notice. No new session.
9. `PUT /v1/account/password {current_password, new_password, lang}` → `200
{status:"ok", session_jwt}`; 400 `weak_password`; 403 `wrong_password` (never 401:
   in this app 401 means the session ended); 409 `no_password`; 429
   `too_many_attempts`. Success replaces the hash, deletes the account's credentials
   on every OTHER install, invalidates the cache and queues the security notice. This
   session stays (the usual rule: a password change ends the other sessions), so a
   retry after a lost reply still authenticates; `session_jwt` is a re-signed JWT of
   the same session, which the app stores. Retry safety: a repeat whose current
   password no longer matches but whose new password is the one set in the last 15
   minutes answers 200 the same way and changes nothing else.
10. `PUT /v1/account/username {username}` → `200 {username}`; "" removes it. Lowercase
    - trim, `^[a-z][a-z0-9_.]{2,29}$`, no "..", no trailing ".", no reserved
      substring (kaata, admin, support, help, official, verified, staff, team, security,
      moderator, system, root); 400 `invalid_username` + reason; 409 `username_taken`;
      10 per hour per account. Allowed only when the account has a password (409
      `no_password`), since a username alone cannot sign in.
11. `PUT /v1/account/name {name}` → `200 {name}`: for accounts with no Google or Apple
    identity only (their provider asserts the name); NFC, bidi controls and
    invisible characters (zero-width space, word joiner, BOM) stripped, ZWNJ and ZWJ
    kept because Dari spelling needs them, 2-60 characters; 400 `invalid_name`, 409
    `provider_name`.
    The onboarding name still uses this endpoint after a nameless email sign-in.
    It updates both `accounts.name` and the explicit display override, preserving
    an older email client's save after a newer client has set an override.
    `PUT /v1/account/display-name {name}` → `200 {name}` is the explicit Kaata
    profile edit for every sign-in provider, with the same sanitization and length
    rule. Migration `055_account_display_name.sql` adds nullable
    `accounts.display_name`; migration 054 remains reserved for deferred deletion.
    Google/Apple sign-in may refresh `accounts.name`, credential profile data and
    the provider-verified account email, but never replaces the explicit override.
    The display-name edit endpoint changes neither proven identity nor email.
    Account-me, sign-in replies, current member profiles and party names use
    `COALESCE(display_name, name)`. Future shared-tally evidence and notification
    snapshots use that current name; previously recorded actor names stay unchanged.
    Account deletion removes the entire account row, including the override.
12. `DELETE /v1/account/password` → `200 {has_password:false}`, also when there is
    none. Only from a Google or Apple session (403 `provider_session_required` from an
    email session), so whoever removes it controls the account's Google or Apple
    sign-in. Deletes the password, the 'email' identity, the username and every
    email-provider session of the account, and mails a "password sign-in removed"
    notice to the old sign-in address. This is the way out when someone else added a
    password.

## 7. Mobile

### lib/auth.ts

- New functions: `emailSignUpStart`, `emailSignUpVerify`, `emailSignIn`,
  `emailResetStart`, `emailResetVerify`, `fetchAccountMe`, `passwordSetupStart`,
  `passwordSetupVerify`, `changePassword`, `setUsername`, `setAccountName`,
  `saveAccountDisplayName`. Typed
  `EmailAuthError(reason, status, extra)`; its message is the reason only, so crash
  reports never carry what the user typed.
- No new static imports (selftests mock lib/auth's imports exhaustively).
- **Different account, all providers**: the client-side sub comparison is removed.
  Every sign-in sends `current_account_id` = app_meta `account_id` when the phone holds
  local data (any vault or person) and the binding was active within the existing
  30-day window (heartbeat now keyed on `account_id`, not `account_google_sub`). On
  409 `different_account` the screen's prompt shows old and new emails (old one from
  app_meta `account_display_email`, which sign-out does not clear) with keep / wipe /
  cancel. Keep → resend with `allow_switch:true`. Wipe → the existing local wipe, a
  fresh install id, then resend without `current_account_id`. Cancel →
  `SignInCancelledByUserError`. Google reuses its ID token, Apple its identity token.
- Retry safety: after a timeout, an `invalid_code` or `account_exists` answer is
  followed by a password sign-in with the same email and password before any error is
  shown.
- Pending code step: when a start succeeds, app_meta `email_flow_pending` stores
  `{purpose, email, sent_at}` (never the password or code). For 15 minutes the email
  flow reopens on the code step; cleared on success, cancel or expiry.
- After a successful email sign-in whose account has no name, `setAccountName` sends
  the local self name (or the onboarding name when it arrives). Every Continue on the
  onboarding name step of an email session sends the CURRENT name (so a name fixed
  after Back is not lost), and names are checked against the server's rule (2-60
  characters after trimming) where they are typed.
- Account settings explicitly saves a Kaata display name for Google, Apple and
  email accounts. A changed or unsettled name must meet the server rule; an
  unchanged provider-imported name does not block a phone-only save. Fresh account
  names prefill untouched fields, without overwriting a current edit or queued name.
  Offline/5xx saves retain the exact name and account id in
  `account_display_name_pending`; check-in retries only for that account. A stale
  queued retry cannot replace a newer edit. Unsupported endpoints and named
  refusals remain visible failures. Saves and cloud-profile reads carry the
  starting session binding so switching accounts cannot apply their results to
  the next account.
- A viewer or clerk may edit their personal account profile while a read-only
  kaata is active. Their own device-local self name changes without authoring a
  ledger rename; the explicit account endpoint provides the current cloud name.
  Authorized ledger renames continue through the signed event log. Unchanged-name
  phone-only saves emit no rename, and ledger permissions remain unchanged.
- Final-review rules: `emailResetVerify`, `passwordSetupVerify` and `changePassword`
  send `lang`; `changePassword` stores the returned `session_jwt`; a leading "@" is
  dropped from a sign-in identifier, as on the server;
  `email_flow_pending` is cleared by every sign-in (any provider) and by sign-out, and
  a set-password pending carries the account id and is ignored for another account;
  before a different-account "keep" or "start fresh" resends a Google or Apple token,
  the token's `exp` is checked (less than 60 s left: a coded failure BEFORE any wipe,
  so the user simply signs in again); a bare 429 is worded without blaming the
  network; a sign-in that started from home returns to the existing home screen
  (`router.dismissTo`), never a second one.

### Screens

- **AuthScreen** (onboarding and /sign-in): Google and Apple cards as now, then a
  secondary, outlined "Continue with email" option on both platforms. The Android
  username link and its form are removed. `/sign-in?mode=email` opens straight on the
  email flow.
- **components/EmailAuthFlow.tsx**, rendered inside AuthScreen's existing
  KeyboardAvoidingView + ScrollView (it renders no ScrollView of its own and uses
  AuthScreen's focusInput/blurInput). Steps: sign-in (Email or username, Password,
  "Forgot password?", "Create an account"), sign-up (Email, "Kaata password" with
  the helper "Make a new password for Kaata, not your Gmail password", shown rules),
  code (one 6-digit field, LTR, digits folded, resend countdown, "Change email", "Check
  Spam"), forgot (Email), reset (code + new password). Onboarding opens on sign-up,
  /sign-in on sign-in. On the flow's FIRST step nothing is auto-focused (the keyboard
  must not hide the step), and the sign-up step shows "Already have an account? Sign
  in" directly under its title, above the fields; the sign-up code step repeats it,
  because a returning user who typed into sign-up receives a notice, not a code. On the sign-up step, a typed @gmail.com address shows "Continue with Google: no
  password needed" when Google is available. Under invalid_credentials: "Joined with
  Google or Apple? Use that button." Every password field has a show/hide toggle.
  Email, username, password and code fields are LTR in both languages. Results and
  failures go back to AuthScreen (completeSignIn, showSignInFailure, the retired
  notice).
- **Account settings**, signed in: a "Sign-in" section with Email (read-only),
  Password ("Set a password" via setup start/verify, or "Change password") and, once a
  password exists, Username. Set a password shows `setup_email` read-only when the
  server gives one (the field only for accounts that must name an address). In a
  Google or Apple session with a password, a destructive "Remove password" (a
  ConfirmDialog) calls `DELETE /v1/account/password`. Screens `app/account-password.tsx` and
  `app/account-username.tsx`, each with `KeyboardAvoidingView behavior="height"
enabled={Platform.OS === "android"}` around a ScrollView using
  `useOnboardingKeyboardScroll`, ref + setTimeout(280) focus, toasts on success.
  `selftest:onboarding-keyboard` checks both files.
- **Profile sheet**, signed out: one "Sign in" row on both platforms → `/sign-in`.
  The dedicated page offers email, Google (when configured) and Apple. All three
  use the same existing-account, recovery and different-account guards. The sheet
  closes before navigation; provider choices do not fill the settings sheet.
- **Copy**: provider-neutral wording for the different-account dialog and the
  invitation/pairing strings that say "Google". All new strings in en and fa.

## 8. Removal of the review-only login

Backend: `internal/auth/review_login.go` and its test, the ReviewSignIn handler, route
and limit, the UpdatePhone no-op, `REVIEW_LOGIN_*` config and wiring, admin
`SetReviewGoogleSub`/`excludedAccountIDs` (back to `operatorAccountIDs`) and its test,
the check-in review skip and its test, the 052 review migration. Mobile:
`signInWithReviewLogin` and its errors, `selftest:review-login`, the username link,
form, profile-sheet row and `mode=username`. Repo: `scripts/review-login.mjs`,
`docs/play-review-login.md`, `REVIEW_LOGIN_*` in env examples and docs.
Kept: the Google back-out fix, `signin_default_vault_id`, the bounded tab sync on
restore, `play-promote --no-send`, the `internal-hold` profile, versionCode 50.

## 9. Store, privacy and review

- Privacy policy: an "Email and password accounts" section (email, password stored
  only as an argon2id hash, optional username, codes and notices sent through the
  named mail provider, 7-day code retention). The reviewer paragraph goes.
  `docs/play-data-safety.md` and Play's Data safety form: account creation by
  username/password; email and user ID collected.
- Apple 4.8 is unaffected (Sign in with Apple stays); in-app deletion covers email
  accounts (5.1.1(v)).
- Play review: an ordinary email account (ideally its own Gmail), created with "Create
  an account" and seeded with Demo Shop and Demo Partner; its id goes into
  `OPERATOR_ACCOUNT_IDS`. Play text, with the exact labels: "Tap Continue with email,
  then Already have an account? Sign in. Enter the email and password below and tap
  Sign in, then Restore from cloud. Please do not use Continue with Google." Before
  every submission, sign in on a fresh install with the published credentials. App
  Store review can use the same email credentials.
- Rollout: the backend and the mail provider must be live before build 50 is sent for
  review. The iOS build with the same flows ships in the same window.

## 10. Tests

Go (real Postgres): canonicalization and policy; hashing (verify, wrong, rehash,
dummy); address validation and dedupe keys; codes (TTL, attempts claimed atomically,
newest-3, single use, per-address failure budget); throttles identical for known and
unknown addresses and identifiers; sign-up (create; taken address gets a notice and
409 at verify; different_account writes nothing); sign-in (email, username, wrong,
unknown, throttle, rehash); reset (no password → notice; sets the hash, revokes every
other credential); setup (first password on a Google account; relay address needs an
email; email_in_use); change password (403, revokes others); username and name rules;
the shared tail (one credential per install; sign-out removes all; 409 before writes
for Google too); retry replay; mail driver selection (log refused in production; no
config → 503); outbox (retry, bodies cleared); deletion cascade. Added by the final
review: code TTL expiry; the newest-3 window; concurrent verifies of one code (exactly
one wins); sign-in rehash of a weaker stored hash; the attempt throttle admitting again
exactly at `retry_after_s`; a refusal reporting the longest wait; start parity when
the global budget is spent (known, Google-only and unknown addresses all 503, and the
refusals record nothing); the per-client budget; the client IP never being an address
the client wrote (`httpx` tests); setup goes to the account's own usable email
(`email_fixed`), and a duplicate account sharing that email does not block it; a
refused setup start still spends its budgets; setup failures spend the address
budget; DELETE password (provider session only, revokes email sessions); the
"password elsewhere" notice; coalesced security notices counted in the global
budget; a +tag address finds a Google account; `kaata_email_key` equals Go's key;
session epochs (a copied JWT dies at a reset or a new sign-in; a password change
keeps the session; check-in refresh keeps the epoch; legacy epoch 0 still works);
change-password replay; setup/verify's wrong code is 400; reset different_account
writes nothing and reset replay; the reset, change and removal handlers dropping
cached sessions; 410 before 409 in the tail; hollow-duplicate adoption is not a
different account; `resolveDefaultVault`; `InvalidateInstall`; the dummy hash under a
busy semaphore; log driver needs `KAATA_ENV=development`; placeholder SMTP values;
the outbox lease and shutdown bookkeeping.
Mobile: `selftest:email-auth` (lib/auth functions with fetch mocks; EmailAuthFlow
steps; the different-account resend; retry fallback; pending step), existing
selftests' mocks updated, onboarding-keyboard extended, tsc.

## 11. Deferred, with the reason

- **A copied JWT of the CURRENT install survives a password change.** A change ends
  every other session but keeps this one (so a retried change still works). A reset,
  or signing out and in again, gives the install a fresh epoch and ends any copy.

- **Proof of install possession** before binding (a device-key signature over a server
  nonce). Today any sign-in can name any install id; this predates email accounts and
  needs a careful change to the device-key flow.
- **Re-authentication before adding a first password** (an auth-time claim). The
  setup flow needs a live session and a code sent to the account's own email; only
  accounts whose email is unusable (Apple relay) name the address themselves.
- **Lockout by a third party (accepted).** The per-address code-failure and mail
  budgets and the per-identifier sign-in limit can be spent by anyone who knows an
  address or username, which blocks password sign-in and recovery for up to 24 h. We
  chose integrity and uniform answers over availability: keying them per client would
  let a distributed attacker guess more codes and passwords, and recording failures
  only where a code exists would reveal which addresses have accounts. Existing
  sessions and Google/Apple sign-in are unaffected, a successful reset clears the
  sign-in limit, and support can clear a key.
- **Origin reachable without Cloudflare.** The client IP rule (§4) holds for
  requests through Cloudflare and for direct requests that Traefik sees with their
  real address. If the server's own address is reachable directly AND something in
  front of Traefik rewrote the peer to an internal address, a client could still
  choose its key. Firewalling the server to Cloudflare's ranges closes it.
- **IPv6 rotation.** A client key is an IPv6 /64, and a free tunnel gives one person
  thousands of them; the address and global budgets still bound what that reaches.
- **Apple relay accounts.** Our mail cannot reach a private relay address until
  mail.kaata.af is registered with Apple's private email relay service (the Apple
  developer account holder can do it). Until then such an account names the
  first-password address itself, a session thief could name their own, and the only
  notice goes to that address. Account → Sign-in shows the sign-in address, and
  Remove password (§6.12) is the way out.
- **Live sockets of revoked sessions** (`/v1/sync/live` re-checks only at connect).
- **Remembering deleted identities** for a future trust score (needs a privacy-policy
  disclosure).
- **A "sign out other phones" button** (reset and password change already do it).
- **Marking self-chosen names** as unverified in other people's views.

## 12. Setup runbook

### Mail provider (one time, Matee)

Codes cannot be sent until this is done; until then the app says email sign-up is
unavailable and Google and Apple keep working.

1. Create a Resend account (resend.com) with kaata.team@gmail.com.
2. Domains, Add domain: `mail.kaata.af`, region `us-east-1`. Copy the exact DNS records
   Resend shows into Cloudflare's `kaata.af` zone, including their generated values.
   The provider may use CNAME records instead of the older SPF TXT and MX layout;
   follow the current domain screen. The records configured on 11 October 2026 are:

   | Type  | Name in Cloudflare's `kaata.af` zone | Value                                         |
   | ----- | ------------------------------------ | --------------------------------------------- |
   | TXT   | `resend._domainkey.mail`             | The generated DKIM public key shown by Resend |
   | CNAME | `rsend.mail`                         | `rsend.forge.rmta.net`                        |
   | CNAME | `send.mail`                          | `send.forge.rmta.net`                         |

   Keep both CNAME records **DNS only** (not proxied). Preserve an existing DMARC
   policy instead of adding a second record: `_dmarc.kaata.af` already contains
   `v=DMARC1;p=none;rua=mailto:hello@kaata.af`. If there is no DMARC policy, add
   `_dmarc.kaata.af TXT "v=DMARC1; p=none;"`. Wait until Resend shows the domain as
   verified before enabling production mail.

3. API Keys, create a key with sending access only, restricted to `mail.kaata.af`.
4. In Dokploy, on the backend, set and redeploy:

   ```
   MAIL_DRIVER=smtp
   SMTP_HOST=smtp.resend.com
   SMTP_PORT=587
   SMTP_USERNAME=resend
   SMTP_PASSWORD=<the API key>
   MAIL_FROM=Kaata <no-reply@mail.kaata.af>
   MAIL_MAX_PER_HOUR=30
   MAIL_MAX_PER_DAY=90
   ```

   The two caps fit Resend's free tier (100 a day); raise them with a paid plan.
   `apps/backend/.env.production` carries these lines commented out: uncomment them
   only together with the real key. The boot log names the active mail driver and
   reports the SMTP login check; if the login fails, email sign-up answers
   "unavailable" until it succeeds. Never set `MAIL_DRIVER=log` on the server: it is
   refused unless `KAATA_ENV=development`, because it prints every code into the log.

5. On a test phone, create an account with a Gmail address and check that the code lands
   in the inbox, not Spam. Then try a wrong password, Forgot password, and a code from
   Persian digits.

Apple relay addresses are refused as sign-in addresses, so no Apple email-relay
registration is needed for codes.

### Play review account

1. On a phone holding none of your own ledgers, install the app, choose Continue with
   email and create an account with a mailbox you control (ideally its own Gmail, not
   the App Store review account). Use a long random password; keep it with the other
   review credentials, never in the repo.
2. Seed Demo Shop and a Demo Partner shared account with a few pending tallies (see the
   App Store notes for the demo shape). Clear Demo Partner's phone number in its own
   Account settings.
3. Look up the account id on production and add it to `OPERATOR_ACCOUNT_IDS`.
4. Play Console, App content, Sign-in details: that email and password, and the
   instructions of §9 with the exact labels ("Continue with email", then "Already have
   an account? Sign in", then "Restore from cloud").
5. Before every submission, sign in with them on a fresh install.
