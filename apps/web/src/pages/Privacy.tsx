import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { WHATSAPP_CONTACT_URL } from "../env";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

// Privacy policy. Kept as plain prose (not i18n keys) so it can be maintained as
// a single legal document; a Dari translation is tracked separately. Both stores
// require a reachable, truthful privacy policy URL once any personal data is
// collected — this page is that URL (kaata.af/privacy) and must stay accurate to
// what the app actually does. When you change a data flow, change this page.
const UPDATED = "22 September 2026";

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
            described below. Deleting the app removes the on-device ledger from the phone.
          </p>
        </Section>

        <Section title="What the app sends on every launch">
          <p>
            When the app starts, it makes a short check-in to our server. This is used to record an
            anonymous install, tell you about updates, and understand overall usage. The check-in
            includes:
          </p>
          <ul className="list-disc ps-5 space-y-1.5">
            <li>
              An <strong>anonymous install ID</strong> — a random identifier generated on your phone
              the first time you open the app. It is not tied to your name unless you provide one
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
              Your <strong>IP address</strong>, taken from the network request, used for approximate
              region and to match a marketing/QR link you may have scanned to your install.
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
            chooses to show the other, every tally’s amount, date and note, and who added, accepted,
            rejected or cancelled it. The browser only opens the app; it does not display your
            ledger. Send the invitation only to its intended recipient. Once claimed, the link alone
            cannot access the account. Access requires a signed-in party or an authorized member of
            their kaata.
          </p>
          <p>
            A shared account belongs to <strong>both</strong> of you, so it outlives either side
            alone: it is not deleted when one of you deletes their Kaata account, because that would
            erase the other person’s record of the same debt. When either of you closes it —
            “Unlink” in the app — it stops accepting new tallies for both of you, and both of you
            keep the closed account as a read-only record of what was owed.
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
            To fix bugs, the app may send diagnostic reports containing the anonymous install ID, a
            short error message, app version, and basic device memory figures, alongside the IP
            address of the request. Error messages are length-limited; we do not intentionally
            collect your ledger content in them.
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
            Anonymous install and usage records are kept for as long as the install is active.
            Diagnostic reports and unclaimed website-visit records are deleted on a rolling basis.
            When you delete your account (below), we remove your account profile, sign-in
            credentials, self-identity fields, and the ledger data you alone own.
          </p>
        </Section>

        <Section title="Deleting your data">
          <p>
            You can delete your account and its server-stored data at any time from{" "}
            <strong>Settings → Delete account</strong> inside the app. You can also request deletion
            here from the web:
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
            Deleting the app from your phone removes the on-device ledger. If you never signed in,
            unshared records have no cloud copy. Bills and shared accounts already sent to another
            person remain available as described above; save your shared-account link before
            uninstalling if it is not connected to a signed-in account.
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
