# Multi-currency shared customer accounts

New shared-account invitations cover the creating customer's configured and
recorded currencies together. The creator chooses a recording mode once and
sends one invitation. The recipient chooses one Kaata/contact and explicitly
joins once. There is no currency picker before creating this invitation.

Every denomination still has its own ordinary tab. Amounts, balances, credit
limits, reviews, source history, settlement boundaries and exports are never
combined or converted across currencies. Existing independent invitations and
their immutable recording modes are not merged or rewritten.

## Storage and protocol

Backend migration `072_multi_currency_tab_groups.sql` adds `tab_groups` and the
nullable `tabs.group_id`. Mobile migration 047 adds nullable `tab_links.group_id`.
Existing rows remain ordinary single-currency tabs.

Group routes use `/v1/tab-groups`: Create, `by-token`, Get, Join, `currencies`,
Close and `regenerate-link`. Full responses contain group metadata and ordinary
per-currency tab responses. Each party's `linked_at_ms` is the authoritative
cutover for that currency; clients must not substitute invitation creation time
or the party's Join timestamp.

The group invitation has a separate `g_` token namespace under `/t/`. Its public
landing remains an app invitation, with generic social artwork. Before Join,
the authenticated invitation preview exposes labels, mode and currency names;
it does not return balances, entries, phone numbers or contact/book bindings.
Full records require the bound participant's ordinary account/book authority.

Creation persists an exact request UUID, cryptographic invitation token and
payload before sending. Join also persists its exact destination and request.
Retries reuse them, including after a lost committed response. The server stores
token and request hashes. Discovery of that exact group must retire its matching
local pending draft; an unrelated group or an ambiguous network result is not
proof that a draft can be discarded. Older group metadata and URL-free responses
cannot replace a newer invitation URL.

Create and Join are all-or-nothing transactions. Close and invitation rotation
also operate on the group together. Account deletion closes group sharing and
retires invitations while retaining the surviving party's authorized history.

## Preserving existing records

Creation validates every currency's opening against the current source under
the same book/contact locks used by private sync. Its currency set must include
the authoritative configured/recorded set. A stale amount, missing denomination
or cutover earlier than its source's recording time refuses the entire request.
Business dates are not recording cutovers.

Before Create or Join, the app requires the contact's applied financial source
to be acknowledged by the server. After preparing history receipts, a short
local writer transaction checks the source and persists the pending request
together. No network request holds the writer lock. Private changes cannot race
between the opening snapshot and the pending invitation's write fence.

Joining cannot silently replace an existing nonzero recipient balance with a
different opening. Notification-only modes require the carried source to match.
For the initial grouped implementation, review-mode Join conservatively refuses
a nonzero recipient source rather than changing it into a pending balance.
Existing records remain untouched on these refusals. This restriction is local
to the new grouped flow; legacy invitations retain their existing behavior.

An untouched invitation can be cancelled without turning its creator's private
records into proposals or erasing their balances. The pending opening withdrawal
is coordinated for every leg.

A genuinely new currency can be activated through the existing joined account
when neither side has private, settled, corrected, deleted or shared source
history to absorb. Existing history needs a source-checked invitation instead;
the automatic activation refuses it. Unsupported or offline activation never
falls through to a private tally. Contact currency choices include active group
currencies without silently changing the Kaata owner's signed settings. Extending
currencies also refuses if an original participant identity is no longer present;
existing authorized history remains available to surviving members.

The three modes remain `review`, `notify`, and `notify_one_way`. The one-way
recipient can view and receive notifications; adding another currency cannot
bypass that restriction. Financial operations continue to target the exact leg.

## Compatibility and rollout

Deploy the compatible backend/migration before using the updated mobile flow.
New clients probe `multi_currency_tabs` and send `X-Kaata-Tab-Group: 1` on tab
and book-sync requests. Existing ungrouped books and invitations remain usable
by their existing clients. A book with grouped history requires an aware client
to restore or sync it, including after sharing closes. Authorization precedes
compatibility disclosure.

Private financial event intake refuses active grouped contacts even when a
caller supplies the compatibility header. Duplicate stored history remains
idempotent. Local private creation/edit/delete/settlement also refuse an active
group or an unresolved group-creation or Join outcome. Refusal retains the
original records and does not create a new signed financial intent. A restored
contact stays marked incomplete until every currency's required historical
period has synced; exports also refuse incomplete history.

This feature does not change onboarding into a multi-currency form. A group
invitation can seed its existing single default-currency field; the eventual
join attaches every group currency without replacing the chosen Kaata default.

## Validation

Backend group and sync tests use an isolated PostgreSQL instance with the full
migration chain. Mobile tests exercise group creation/join, exact cutovers,
ambiguous retries, cache restoration, currency admission and native-screen
callbacks with synthetic accounts. Existing history, export, role, credit,
notification and unused-invitation suites remain regression checks. Production
records, messages and store distribution are not part of these tests.

October 28 verification completed 1,112 server checks with no assertion failures,
39 mobile selftest suites plus TypeScript, and 219 web tests plus TypeScript.
The initial server run reached its time limit; all 169 unfinished top-level
tests were inventoried and resumed successfully. Only the optional bill-preview
writer and manual scratch reimport rehearsals skipped. The disposable PostgreSQL
instance used faster commit settings for the remaining checks; these tests
verify transactions and source preservation, not machine-crash durability.
No physical-device test, mobile build or store submission was performed.
