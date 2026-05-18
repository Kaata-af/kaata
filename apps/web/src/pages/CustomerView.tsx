import { Link, useParams } from "react-router-dom";

// Placeholder for /v/:token — Phase 2 customer-facing balance view.
// Will decode a signed JSON payload from the URL token and render the
// customer's kaata at a given shop. For now, shows a coming-soon screen
// so the route is wired and the SPA fallback in Caddy is validated.
export function CustomerView() {
  const { token } = useParams<{ token: string }>();

  return (
    <main className="px-6 py-24 max-w-2xl mx-auto text-center">
      <p className="text-[11px] font-medium tracking-wider uppercase text-[#7a5f1f] mb-4">
        Coming soon
      </p>
      <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-neutral-900">
        Customer kaata view
      </h1>
      <p className="mt-6 text-lg text-neutral-600 leading-relaxed">
        Shopkeepers will be able to send a link like this one and you'll see your full kaata —
        balance, every debt, every payment — without installing the app.
      </p>
      <p className="mt-8 text-xs text-neutral-400 font-mono break-all">token: {token}</p>

      <Link
        to="/"
        className="mt-10 inline-block text-sm text-neutral-600 hover:text-neutral-900 transition-colors"
      >
        ← Back to Kaata
      </Link>
    </main>
  );
}
