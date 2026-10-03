import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { WHATSAPP_CONTACT_URL } from "../env";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

// Privacy policy. Kept as plain prose (not i18n keys) so it can be maintained as
// a single legal document; a Dari translation is tracked separately. Both stores
// require a reachable, truthful privacy policy URL once any personal data is
// collected — this page is that URL (kaata.af/privacy) and must stay accurate to
// what the app actually does. When you change a data flow, change this page.
const UPDATED = "3 October 2026";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-bold tracking-tight text-neutral-900">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-neutral-600">{children}</div>
    </section>
  );
}

export function Privacy() {
  return (
    <main>
      <SiteHeader />

      <article className="px-6 py-16 md:py-20 max-w-2xl mx-auto">
        <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500">
          Privacy
        </p>
        <h1 className="mt-3 text-3xl md:text-4xl font-bold tracking-tight text-neutral-900">
          Kaata Privacy Policy
        </h1>
        <p className="mt-4 text-sm text-neutral-500">Last updated: {UPDATED}</p>

        <p className="mt-8 text-[15px] leading-relaxed text-neutral-600">
          Kaata is a digital khata (ledger) for tracking what people owe you and what you owe them.
          It is built to be local-first: your customer ledger lives on your phone. This policy
          explains exactly what leaves your device, when, and why — and how to get your data
          deleted.
        </p>

        <Section title="What stays on your phone">
          <p>
            Your ledger — the people you add, their phone numbers, the amounts, notes, and running
            balances — is stored in a database on your device. If you never sign in, that ledger
            data is not uploaded unless you choose to share a bill. A WhatsApp reminder uploads a
            snapshot of that one customer’s balance and entries to create the shareable link (see
            below). Shared accounts require sign-in in the app and are stored on our server as
            described below. Deleting the app removes the on-device ledger from the phone. If your
            phone backs up app data to Google or iCloud, that backup can include a copy of the
            ledger.
          </p>
        </Section>

        <Section title="What the app sends on every launch">
          <p>
            When the app starts, it makes a short check-in to our server. This is used to record an
            installation, tell you about updates, and understand overall usage. The check-in
            includes:
          </p>
          <ul className="list-disc ps-5 space-y-1.5">
            <li>
              An <strong>installation ID</strong> — a random identifier generated on your phone the
              first time you open the app. It is not tied to your name unless you provide one
              (below).
            </li>
            <li>
              <strong>App version, platform, and usage counters</strong> (e.g. how many entries you
              have made) — never the entries themselves.
            </li>
            <li>
              Your <strong>own profile</strong> — the name, phone number, and shop name you enter
              for yourself during setup — so we can understand who is using Kaata and reach out for
              feedback. This is your identity as the shopkeeper only. It never includes your
              customers or suppliers.
            </li>
            <li>
              Your <strong>IP address</strong>, taken from the network request, used to match a
              marketing/QR link you may have scanned to your install.
            </li>
          </ul>
        </Section>

        <Section title="When you sign in with Google or Apple">
          <p>
            Signing in is optional and enables cloud backup and sync across your devices. If you
            sign in:
          </p>
          <ul className="list-disc ps-5 space-y-1.5">
            <li>
              We receive your <strong>email address, name, and profile picture</strong> from Google
              or Apple to create your account. Sign in with Apple’s private-relay email is
              supported.
            </li>
            <li>
              Your <strong>ledger is backed up to our server</strong> so you can restore it on a new
              phone. This backup includes customer and supplier{" "}
              <strong>names, phone numbers, debt amounts, and notes</strong>, stored in transit over
              HTTPS and at rest on our database. It is not additionally encrypted with a key only
              you hold.
            </li>
          </ul>
        </Section>

        <Section title="Sharing a bill over WhatsApp">
          <p>
            When you send a customer a reminder, Kaata creates a link (kaata.af/v/…) that shows that
            one customer a dated bill: their balance and entries with you at that moment, plus your
            shop name. Like a paper bill handed across the counter, a sent bill{" "}
            <strong>belongs to the person you gave it to</strong> — it is permanent, it never
            changes after it is sent, and we do not take it back, edit it, or remove it, even if you
            delete your account. Anyone with the link can view it, so share it only with the
            intended person.
          </p>
        </Section>

        <Section title="Shared accounts with another person">
          <p>
            A contact’s account can be turned into a <strong>shared account</strong>, where the
            other person opens an invitation (kaata.af/t/…) in the Kaata app, signs in, and keeps
            the same running account with you. Because both of you must see the same figures, a
            shared account is
            <strong> stored on our server</strong>, not only on your phone: the name each of you
            chooses to show the other, every tally’s amount, date and note, who added, accepted,
            rejected or cancelled it, and who cleared a settled balance and when. The{" "}
            <strong>phone number on your account</strong> is also shown to the other party, and to
            the members of their kaata, so they can match the invitation to a contact on their
            phone; it is a display detail, not verified identity. The browser only opens the app; it
            does not display your ledger. Send the invitation only to its intended recipient. Once
            claimed, the link alone cannot access the account. Access requires a signed-in party or
            an authorized member of their kaata.
          </p>
          <p>
            A shared account belongs to <strong>both</strong> of you, so it outlives either side
            alone: it is not deleted when one of you deletes their Kaata account, because that would
            erase the other person’s record of the same debt. When either of you closes it —
            “Unlink” in the app — it stops accepting new tallies for both of you, and both of you
            keep the closed account as a read-only record of what was owed.
          </p>
          <p>
            Deleting a login does not accept a pending tally, settle a balance, or erase the other
            participant’s shared history. We retain the shared entries and their recorded status,
            author and reviewer names, who cleared a settled balance, account references, roles
            where recorded, and action times so authorized participants can read and export that
            history. These records contain personal data; they are not anonymous. Older entries may
            have incomplete attribution, and a name or account sign-in is not proof of legal
            identity.
          </p>
          <p>
            If account deletion leaves one side with nobody authorized to review its tallies, the
            shared account closes and unused invitations stop working. Deleting a staff member’s
            login does not close a shared account that still has authorized participants.
          </p>
        </Section>

        <Section title="Shared-account notifications">
          <p>
            If you allow notifications, we register your device’s notification token with the shared
            accounts you can access. Expo’s push service and Apple or Google deliver the alerts.
            Alerts include the other party’s display name, the tally amount and currency, its
            outcome, and shared-account identifiers — never notes, balances or invitation links. You
            can turn notifications off in your phone’s settings; the shared account continues to
            work without them.
          </p>
          <p>
            Delivery jobs expire after 24 hours and unrenewed device registrations stop receiving
            alerts after 30 days. We check current access before sending. Your in-app notification
            history and read status are stored with your shared accounts independently of push
            delivery. You can hide notification previews using your phone’s settings.
          </p>
        </Section>

        <Section title="Contacts">
          <p>
            With your permission, Kaata can read your phone’s contacts so you can add a customer by
            picking them instead of typing, and can save a customer you add back into your phone
            book. Contact access is only used for these features; your contact list is not uploaded
            to our servers.
          </p>
        </Section>

        <Section title="Crash and diagnostic reports">
          <p>
            To fix bugs, the app may send diagnostic reports containing the installation ID, a short
            error message, app version, and basic device memory figures, alongside the IP address of
            the request. Error messages are length-limited; we do not intentionally collect your
            ledger content in them.
          </p>
        </Section>

        <Section title="Website analytics">
          <p>
            When you visit kaata.af, we record the visit (page, referrer, the marketing source of
            any QR link, plus the IP address and browser sent with the request) to understand how
            people find Kaata. We do not use third-party advertising trackers.
          </p>
        </Section>

        <Section title="How long we keep data">
          <p>
            Installation and usage records are retained separately from account profiles for
            operational reporting. They are not necessarily anonymous. Diagnostic reports and
            unclaimed website-visit records are deleted on a rolling basis. When you delete your
            account (below), we remove your account profile, sign-in credentials, the self-identity
            fields of installations still linked to your account, and cloud copies of kaatas you
            own. Those installations are retired so they cannot upload the deleted profile again.
          </p>
          <p>
            Shared tally history remains available to authorized participants after account
            deletion. Retaining it does not give us permission to use it for marketing. Contact us
            to request review of personal information in a retained shared record; we assess the
            request alongside the other participant’s recordkeeping needs and applicable law.
          </p>
          {/* The admin outreach log (outreach_contacts/outreach_touches,
              migration 044) is keyed by phone with no FK; account deletion
              never touches it. Keep in step with the delete-account page. */}
          <p>
            If we have contacted you about Kaata, for example on WhatsApp, or tried to, we keep your
            phone number with the dates and outcome of those messages and our notes, so we don’t
            message you twice. We keep this record apart from accounts, so deleting your account
            does not remove it, and we don’t delete it automatically; contact us if you want it
            removed.
          </p>
        </Section>

        {/* What deletion removes and keeps mirrors auth/delete_account.go and
            docs/mutual-tab-design.md "Account deletion and shared evidence";
            the path mirrors app/index.tsx -> ProfileSettingsSheet ->
            app/account.tsx, as on the delete-account page. */}
        <Section title="Deleting your data">
          <p>
            If you are signed in, you can delete your account at any time inside the app: tap your
            profile picture or initials on the home screen, then{" "}
            <strong>Account settings → Privacy &amp; data → Delete account</strong>. This
            permanently removes your account profile and sign-in credentials, your memberships in
            kaatas other people own, the cloud copies of kaatas you own, and the name, phone number,
            shop name and crash reports recorded from each installation still linked to your
            account.
          </p>
          <p>
            Other participants keep shared tally history and recorded acknowledgements, including
            the names recorded with them. A kaata someone else owns keeps the entries you added to
            it and its record of any invitation sent to your email. Deleting your account does not
            settle any balance. Installation and usage records, and any record of our messages to
            you, are kept as described above. You can also request deletion here from the web, for
            example if you never signed in or cannot open the app:
          </p>
          <p>
            <a
              href={WHATSAPP_CONTACT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
            >
              Request account &amp; data deletion →
            </a>
          </p>
          <p>
            The app clears the ledger on the phone where you delete your account once our server
            confirms the deletion. Other devices lose access to the deleted account, but may still
            hold local copies or files you exported, and your phone’s own Google or iCloud backup
            may still include the ledger. If you never signed in, unshared records have no copy on
            our servers. Bills and shared accounts already sent to another person remain available
            as described above. Export important records before deleting your account; an invitation
            link does not restore a deleted account's access.
          </p>
        </Section>

        <Section title="Children">
          <p>Kaata is intended for shopkeepers and is not directed at children.</p>
        </Section>

        <Section title="Changes and contact">
          <p>
            If this policy changes, we will update the date at the top of this page. For any privacy
            question or request, contact us on{" "}
            <a
              href={WHATSAPP_CONTACT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
            >
              WhatsApp
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
