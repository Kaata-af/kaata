import type { ReactNode } from "react";

export function FeatureSection(props: {
  eyebrow: string;
  title: string;
  body: string;
  mockup: ReactNode;
  reverse?: boolean;
}) {
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
        <div className={`flex justify-center ${props.reverse ? "md:order-1" : ""}`}>
          {props.mockup}
        </div>
      </div>
    </section>
  );
}
