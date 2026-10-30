import type { ReactNode } from "react";

export function FeatureSection(props: {
  eyebrow: string;
  title: string;
  body: string;
  mockup: ReactNode;
  reverse?: boolean;
  tone?: "sage" | "rose" | "glass";
}) {
  const tone = {
    sage: "bg-entry-received-bg/40 border-entry-received-coin",
    rose: "bg-entry-gave-bg/40 border-entry-gave-coin",
    glass: "bg-surface-balance border-surface-balance-border",
  }[props.tone ?? "glass"];
  return (
    <section className="px-6 py-20 md:py-28 max-w-6xl mx-auto">
      <div className="grid md:grid-cols-2 gap-12 md:gap-20 items-center">
        <div className={props.reverse ? "md:order-2" : ""}>
          <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500 mb-4">
            {props.eyebrow}
          </p>
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight leading-tight text-neutral-900">
            {props.title}
          </h2>
          <p className="mt-6 text-lg text-neutral-600 leading-relaxed max-w-md">{props.body}</p>
        </div>
        <div
          className={`flex justify-center rounded-[2rem] border py-10 sm:px-6 md:py-12 ${tone} ${props.reverse ? "md:order-1" : ""}`}
        >
          {props.mockup}
        </div>
      </div>
    </section>
  );
}
