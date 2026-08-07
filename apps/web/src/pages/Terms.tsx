import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { WHATSAPP_CONTACT_URL } from "../env";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

// Terms of Service. Plain prose (not i18n keys) so it can be maintained as a
// single legal document; a Dari translation is tracked separately. Linked from
// the Play/App Store listings and the site footer. Keep it accurate to what the
// app actually does — when you change how the service works, change this page.
const UPDATED = "7 August 2026";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-lg font-bold tracking-tight text-neutral-900">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-neutral-600">{children}</div>
    </section>
  );
}

export function Terms() {
  return (
    <main>
      <SiteHeader />

      <article className="px-6 py-16 md:py-20 max-w-2xl mx-auto">
        <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500">Legal</p>
        <h1 className="mt-3 text-3xl md:text-4xl font-bold tracking-tight text-neutral-900">
          Kaata Terms of Service
        </h1>
        <p className="mt-4 text-sm text-neutral-500">Last updated: {UPDATED}</p>

        <p className="mt-8 text-[15px] leading-relaxed text-neutral-600">
          These terms are the agreement between you and Kaata for your use of the Kaata app and
          website (the “Service”). By downloading, installing, or using Kaata, you agree to them. If
          you do not agree, please don’t use the Service.
        </p>

        <Section title="What Kaata is">
          <p>
            Kaata is a free digital khata (ledger) for tracking what people owe you and what you owe
            them, and for sending payment reminders over WhatsApp. Your ledger is stored on your
            device. Signing in with Google or Apple is optional and adds cloud backup and sync
            across your devices.
          </p>
        </Section>

        <Section title="Your account">
          <p>
            You may use Kaata without an account. If you create one by signing in, you are
            responsible for keeping access to your Google or Apple sign-in secure. You can delete
            your account and its cloud data at any time from Settings → Delete account in the app.
          </p>
        </Section>

        <Section title="Your data and your responsibility">
          <p>
            The ledger content you enter — names, phone numbers, amounts, and notes — is yours. You
            are responsible for it being accurate and for having the right to store the contact
            information you enter. Kaata is a record-keeping tool; it does not verify, collect, or
            enforce debts, is not a lender, bank, or payment service, and does not move money.
          </p>
          <p>
            Reminder links you generate and share (for example over WhatsApp) show the recipient a
            dated bill: a snapshot of their balance and entries with you at the moment you sent it.
            Like a paper bill handed across the counter, a sent bill belongs to the person you gave
            it to — it is <strong>permanent and cannot be withdrawn</strong> after sending. Share
            bills only with the person they’re meant for.
          </p>
        </Section>

        <Section title="Acceptable use">
          <p>You agree not to use Kaata to:</p>
          <ul className="list-disc ps-5 space-y-1.5">
            <li>break the law or infringe anyone’s rights;</li>
            <li>harass, threaten, or deceive anyone, including through reminder messages;</li>
            <li>
              attempt to disrupt, overload, reverse-engineer, or gain unauthorized access to the
              Service or other users’ data;
            </li>
            <li>store data you have no right to store, or use the app for illegal lending.</li>
          </ul>
        </Section>

        <Section title="Availability and changes">
          <p>
            Kaata is offered free of charge and is provided as it is available. We may add, change,
            or discontinue features, and we may update or suspend the cloud sync service. The core
            local ledger is designed to keep working offline on your device.
          </p>
        </Section>

        <Section title="No warranty">
          <p>
            The Service is provided “as is” and “as available,” without warranties of any kind,
            whether express or implied, including fitness for a particular purpose and uninterrupted
            or error-free operation. You are responsible for keeping your own copy of important
            records; while Kaata backs up signed-in ledgers, we cannot guarantee against all loss.
          </p>
        </Section>

        <Section title="Limitation of liability">
          <p>
            To the maximum extent permitted by law, Kaata and its makers are not liable for any
            indirect, incidental, or consequential damages, or for any loss of data or profits,
            arising from your use of (or inability to use) the Service. Because Kaata is free, our
            total liability to you is limited to the amount you paid for it — which is nothing.
          </p>
        </Section>

        <Section title="Changes to these terms">
          <p>
            We may update these terms. When we do, we’ll change the date at the top of this page.
            Continuing to use Kaata after a change means you accept the updated terms.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about these terms? Reach us on{" "}
            <a
              href={WHATSAPP_CONTACT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
            >
              WhatsApp
            </a>
            . See also our{" "}
            <Link
              to="/privacy"
              className="font-semibold text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
            >
              Privacy Policy
            </Link>
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
