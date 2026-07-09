import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

// Account-deletion page — required by Google Play for any app with an account
// system. Plain English prose (not i18n keys), matching Privacy.tsx / Terms.tsx.
// Every claim here must stay true to what the app + backend actually do:
//   - in-app path: app/index.tsx (profile chip) -> ProfileSettingsSheet "Account
//     settings" -> app/account.tsx "Privacy & data" -> "Delete account" -> confirm.
//   - server erasure: DELETE /v1/account -> auth/service.go DeleteAccount (hard-
//     deletes account + owned vaults + their events; nulls install self-identity;
//     anonymizes authored events in others' vaults).
//   - retention: kaata.af/v/<token> share snapshots self-expire in 90 days
//     (shared/service.go shareTTL = 90*24h) and are NOT erased by account deletion.
// If any of those change, change this page.
const UPDATED = "9 July 2026";
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
            The quickest way to delete your account and everything backed up to Kaata’s servers is
            from inside the app:
          </p>
          <ol className="list-decimal ps-5 space-y-1.5">
            <li>Open Kaata.</li>
            <li>
              On the home screen, tap your <strong>profile picture / initials</strong> in the
              top-right corner.
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
            This permanently deletes your account and cloud data and{" "}
            <strong>cannot be undone</strong>. It also removes the ledger from that phone. The
            “Delete account” option appears only when you are signed in with Google or Apple.
          </p>
        </Section>

        <Section title="If you can’t open the app">
          <p>
            If you’ve lost access to your phone or can’t reach the button, email us and we’ll delete
            your account and data for you:
          </p>
          <p>
            <a
              href={`mailto:${EMAIL}?subject=Account%20deletion%20request`}
              className={linkClass}
            >
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
              <strong>Your account and sign-in details</strong> — your email, name, profile photo,
              and the phone number on your account, as provided by Google or Apple.
            </li>
            <li>
              <strong>Your backed-up ledger</strong> — the customers and suppliers you added, their
              phone numbers, and the amounts, notes, and balances in the ledgers you own.
            </li>
            <li>
              <strong>Your saved sessions</strong>, so you are signed out on every device.
            </li>
            <li>
              <strong>Crash and diagnostic reports</strong> linked to your installs, and your name,
              phone number, and shop name are cleared from your install record.
            </li>
          </ul>
          <p>
            On your phone, the app also wipes the on-device ledger and resets to a fresh install.
          </p>
        </Section>

        <Section title="What is kept, and for how long">
          <ul className="list-disc ps-5 space-y-1.5">
            <li>
              <strong>Shared reminder links.</strong> If you ever sent a customer their balance
              through a Kaata reminder link (kaata.af/v/…), that link holds a snapshot of that one
              customer’s name and entries. These links are <strong>not</strong> removed the moment
              you delete your account — they automatically expire and are deleted{" "}
              <strong>within 90 days</strong>.
            </li>
            <li>
              <strong>Shared ledgers owned by someone else.</strong> If you took part in a ledger
              another person owns, the entries you added stay in that person’s ledger (it is their
              record), but they are no longer linked to your account.
            </li>
            <li>
              <strong>Anonymous usage data.</strong> We keep non-identifying records — such as
              install and feature-usage counts and website-visit analytics — to understand overall
              usage. These do not contain your ledger. (Crash reports are deleted within 90 days.)
            </li>
          </ul>
        </Section>

        <Section title="Deleting only some of your data">
          <p>
            You don’t have to delete your whole account to remove a single customer or entry. In the
            app, open a customer to remove their entries or remove the customer. What happens on our
            servers depends on whether you are signed in:
          </p>
          <ul className="list-disc ps-5 space-y-1.5">
            <li>
              If you use Kaata <strong>without signing in</strong>, nothing was ever uploaded — the
              change only affects your phone.
            </li>
            <li>
              If you are <strong>signed in</strong>, the change syncs and the customer or entry
              disappears from your ledger. The underlying record is fully erased from our servers
              when you delete your entire account (above).
            </li>
          </ul>
        </Section>

        <Section title="Using Kaata without an account">
          <p>
            If you never signed in, your ledger was never uploaded — it lives only on your phone, and
            uninstalling the app deletes it. To also have us remove the basic profile info the app
            sends when it checks for updates (your name, phone number, and shop name), email{" "}
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
