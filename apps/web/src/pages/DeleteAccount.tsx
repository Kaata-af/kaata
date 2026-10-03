import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

// Account-deletion page — required by Google Play for any app with an account
// system. Plain English prose (not i18n keys), matching Privacy.tsx / Terms.tsx.
// Every claim here must stay true to what the app + backend actually do:
//   - in-app path: app/index.tsx (profile chip) -> ProfileSettingsSheet "Account
//     settings" -> app/account.tsx "Privacy & data" -> "Delete account" -> confirm.
//   - server erasure: DELETE /v1/account -> auth/delete_account.go DeleteAccount
//     (hard-deletes account + credentials + memberships + owned vaults and their
//     events; retires the account's installs, nulling their self-identity and
//     deleting their crash reports; detaches the login from contributions in
//     others' vaults). The phone wipes its ledger only after the server confirms.
//   - kept for other participants: shared-tally entries, statuses and recorded
//     author/reviewer names, account IDs, roles and times (migrations 049-051,
//     including who cleared a zero balance in tab_settlements), signed author
//     IDs on events in others' vaults, and those vaults' invitation history
//     (vault_audit_log invite_issued keeps target_email). Deletion never settles
//     a balance; see docs/mutual-tab-design.md "Account deletion and shared
//     evidence".
//   - "still linked": only installs whose installs.account_id is this account
//     (or legacy unbound ones holding only its credentials) are retired. A
//     phone since signed in to another account keeps its self-profile and
//     crash reports (auth TestDeletionRetiresOwnAndLegacyInstallsButNotSwitchedAccount).
//   - kept by us: the admin outreach log (outreach_contacts/outreach_touches,
//     migration 044) is keyed by phone with no FK and deletion never touches
//     it, for the account's own number and for ledger numbers we messaged.
//   - "not uploaded to our servers", never "only on your phone": Android Auto
//     Backup and device transfer carry kaata.db (plugins/withBackupRules.js)
//     and iCloud device backups include it (expo-sqlite keeps it in Documents).
//   - retention: kaata.af/v/<token> bill snapshots are PERMANENT (paper rule
//     2026-08-07 — no TTL, no revocation; internal/shared/service.go) and are
//     NOT erased by account deletion: there is no account linkage. The
//     snapshot still contains personal data; lack of a FK is not anonymisation.
// If any of those change, change this page.
const UPDATED = "3 October 2026";
const EMAIL = "hello@kaata.af";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-bold tracking-tight text-neutral-900">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-neutral-600">{children}</div>
    </section>
  );
}

const linkClass =
  "font-semibold text-neutral-900 underline underline-offset-2 hover:text-neutral-700";

export function DeleteAccount() {
  return (
    <main>
      <SiteHeader />

      <article className="px-6 py-16 md:py-20 max-w-2xl mx-auto">
        <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500">
          Account deletion
        </p>
        <h1 className="mt-3 text-3xl md:text-4xl font-bold tracking-tight text-neutral-900">
          Delete your Kaata account
        </h1>
        <p className="mt-4 text-sm text-neutral-500">Last updated: {UPDATED}</p>

        <p className="mt-8 text-[15px] leading-relaxed text-neutral-600">
          Kaata is a digital khata (ledger) for tracking what people owe you and what you owe them.
          This page explains how to delete your Kaata account and the data connected to it, exactly
          what is removed, and what is kept and for how long.
        </p>

        <Section title="Delete your account from the app">
          <p>
            The quickest way to delete your account and the cloud copies of kaatas you own is from
            inside the app:
          </p>
          <ol className="list-decimal ps-5 space-y-1.5">
            <li>Open Kaata.</li>
            <li>
              On the home screen, tap your <strong>profile picture / initials</strong>.
            </li>
            <li>
              In the menu that opens, tap <strong>“Account settings”</strong>.
            </li>
            <li>
              On the Account screen, scroll down to the <strong>“Privacy &amp; data”</strong>{" "}
              section.
            </li>
            <li>
              Tap <strong>“Delete account”</strong>.
            </li>
            <li>
              In the <strong>“Delete your account?”</strong> dialog, tap{" "}
              <strong>“Delete account”</strong> to confirm.
            </li>
          </ol>
          <p>
            This permanently deletes your account and the cloud copies of kaatas you own and{" "}
            <strong>cannot be undone</strong>. It also removes the ledger from that phone. The
            “Delete account” option appears only when you are signed in with Google or Apple.
          </p>
        </Section>

        <Section title="If you can’t open the app">
          <p>
            If you’ve lost access to your phone or can’t reach the button, email us and we’ll delete
            your account for you, with the same result as deleting it in the app (described below):
          </p>
          <p>
            <a href={`mailto:${EMAIL}?subject=Account%20deletion%20request`} className={linkClass}>
              {EMAIL}
            </a>
          </p>
          <p>
            Please send the request from the email address you signed in with, or include the phone
            number or shop name on your account, so we can find and verify it. We’ll action the
            deletion and confirm by email.
          </p>
        </Section>

        <Section title="What is deleted">
          <p>When your account is deleted, we permanently remove from our servers:</p>
          <ul className="list-disc ps-5 space-y-1.5">
            <li>
              <strong>Your account and sign-in details</strong> — your email, name and profile photo
              as provided by Google or Apple, and the phone number on your account. Copies recorded
              elsewhere stay as described below: your name on shared tallies, your email on any
              invitation to someone else’s kaata, and your number in any record of our messages to
              you.
            </li>
            <li>
              <strong>Your backed-up ledger</strong> — the customers and suppliers you added, their
              phone numbers, and the amounts, notes, and balances in the ledgers you own.
            </li>
            <li>
              <strong>Your saved sessions</strong>, so you are signed out on every device.
            </li>
            <li>
              <strong>Crash and diagnostic reports</strong> from installations still linked to your
              account, and the name, phone number, and shop name recorded on them. An installation
              stays linked to your account until a different account signs in on it.
            </li>
          </ul>
          <p>
            On the phone where you complete deletion, the app wipes the on-device ledger and resets
            to a fresh install once our server confirms the deletion. Other devices lose account
            access but may still hold local copies, and your phone’s own Google or iCloud backup may
            keep a copy until that backup is replaced or deleted. Files you exported or sent to
            someone else are not remotely erased. Export any private records you need before
            deleting your account.
          </p>
        </Section>

        <Section title="What is kept, and for how long">
          <ul className="list-disc ps-5 space-y-1.5">
            <li>
              <strong>Shared tally history.</strong> Other authorized participants keep the entries,
              amounts, notes, recorded names, author and reviewer references, who cleared a settled
              balance, action times and acceptance, rejection or cancellation status. Deletion does
              not settle a balance or turn pending tallies into accepted ones. If one side no longer
              has an authorized reviewer, the shared account closes and unused invitations stop
              working. Existing records remain readable and exportable; deleting an individual staff
              member does not close an otherwise represented shared account.
            </li>
            <li>
              <strong>Sent bills.</strong> If you ever sent a customer their balance through a Kaata
              bill link (kaata.af/v/…), that link holds a dated snapshot of that one customer’s name
              and entries. Like a paper bill handed across the counter, a sent bill belongs to the
              person you gave it to: it is <strong>not removed when you delete your account</strong>{" "}
              and does not expire. Bills are stored without any connection to your account.
            </li>
            <li>
              <strong>Shared ledgers owned by someone else.</strong> If you took part in a ledger
              another person owns, the entries you added stay in that person’s ledger (it is their
              record). Your login is removed, while recorded attribution and signed author
              references remain part of that history. If someone invited you to their kaata by
              email, their record of that invitation, including your email address, also stays.
            </li>
            <li>
              <strong>Usage and operational records.</strong> Installation identifiers, usage
              history and website-visit records are retained separately from your login. Your
              self-profile fields are cleared from installations still linked to your account, and
              those installations are retired so they cannot upload that profile again. These
              records are not necessarily anonymous. Diagnostics linked to the retired installations
              are removed during deletion; other crash reports expire within 90 days.
            </li>
            <li>
              <strong>Records of our messages.</strong> If we have contacted you about Kaata, for
              example on WhatsApp, or tried to, we keep your phone number with the dates and outcome
              of those messages and our notes, so we don’t message you twice. We keep these records
              apart from accounts and ledgers, so deleting your account does not remove them,
              including the record for any number in your ledger that we contacted. We don’t delete
              them automatically; contact us if you want yours removed.
            </li>
          </ul>
          <p>
            Retained shared records contain personal data and remain available after account
            deletion. Their preservation is for the participants’ shared history, not marketing. For
            an erasure or correction request about a retained record, contact us; we review it
            alongside the other participant’s recordkeeping needs and applicable law. Older entries
            may have incomplete attribution. Recorded names and account sign-in do not establish
            verified legal identity.
          </p>
        </Section>

        <Section title="Deleting only some of your data">
          <p>
            You don’t have to delete your whole account to remove a single customer or entry. In the
            app, open a customer to remove their entries or remove the customer. What happens on our
            servers depends on whether you are signed in:
          </p>
          <ul className="list-disc ps-5 space-y-1.5">
            <li>
              If you use Kaata <strong>without signing in</strong>, your ledger is not backed up to
              our servers — the change only affects your phone. A bill you already sent is not
              changed (see above).
            </li>
            <li>
              If you are <strong>signed in</strong>, the change syncs and the customer or entry
              disappears from your ledger. In a kaata you own, the underlying record is erased from
              our servers when you delete your entire account (above). Shared tally history and
              entries in a kaata someone else owns are kept as described above.
            </li>
          </ul>
        </Section>

        <Section title="Using Kaata without an account">
          <p>
            If you never signed in, your ledger was never uploaded to Kaata’s servers — apart from
            any bill you sent (see above), it lives on your phone, and uninstalling the app deletes
            it from the phone. If your phone backs up app data to Google or iCloud, that backup may
            keep a copy until it is replaced or you delete it. To also have us remove the basic
            profile info the app sends when it checks for updates (your name, phone number, and shop
            name), email{" "}
            <a href={`mailto:${EMAIL}?subject=Delete%20my%20data`} className={linkClass}>
              {EMAIL}
            </a>
            .
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about deleting your account or your data? Email{" "}
            <a href={`mailto:${EMAIL}`} className={linkClass}>
              {EMAIL}
            </a>
            .
          </p>
        </Section>

        <div className="mt-14">
          <Link
            to="/"
            className="inline-block bg-neutral-900 text-white font-semibold px-7 py-3 rounded-lg hover:bg-neutral-800 transition-colors text-sm"
          >
            ← Back to home
          </Link>
        </div>
      </article>

      <SiteFooter />
    </main>
  );
}
