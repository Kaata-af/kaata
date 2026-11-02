import type { ReactNode } from "react";
import { Card } from "./ui/card";

export function FeatureSection(props: {
  eyebrow: string;
  title: string;
  body: string;
  highlights?: readonly string[];
  mockup: ReactNode;
  reverse?: boolean;
  wide?: boolean;
  tone?: "sage" | "rose" | "glass";
}) {
  const tone = {
    sage: "bg-entry-received-bg/40 border-entry-received-coin",
    rose: "bg-entry-gave-bg/40 border-entry-gave-coin",
    glass: "bg-surface-balance border-surface-balance-border",
  }[props.tone ?? "glass"];
  return (
    <section className="px-6 py-20 md:py-28 max-w-6xl mx-auto">
      <div
        className={props.wide ? "space-y-10" : "grid md:grid-cols-2 gap-12 md:gap-20 items-center"}
      >
        <div className={`min-w-0 ${props.wide ? "max-w-3xl" : props.reverse ? "md:order-2" : ""}`}>
          <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500 mb-4">
            {props.eyebrow}
          </p>
          <h2 className="text-3xl md:text-5xl font-bold tracking-tight leading-tight text-neutral-900">
            {props.title}
          </h2>
          <p
            className={`mt-6 text-lg text-neutral-600 leading-relaxed ${props.wide ? "max-w-2xl" : "max-w-md"}`}
          >
            {props.body}
          </p>
          {props.highlights ? (
            <ul
              className={
                props.wide ? "mt-7 grid gap-3 sm:grid-cols-3 sm:gap-6" : "mt-7 max-w-md space-y-3"
              }
            >
              {props.highlights.map((highlight) => (
                <li
                  key={highlight}
                  className="flex items-start gap-3 text-sm leading-relaxed text-neutral-600"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-neutral-900"
                  >
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                  <span>{highlight}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <Card
          className={`min-w-0 flex justify-center rounded-[2rem] py-10 sm:px-6 md:py-12 shadow-none ${tone} ${!props.wide && props.reverse ? "md:order-1" : ""}`}
        >
          {props.mockup}
        </Card>
      </div>
    </section>
  );
}
