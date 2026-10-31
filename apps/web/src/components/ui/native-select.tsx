import * as React from "react";
import { cn } from "@/lib/utils";

// shadcn Native Select, adapted to this app's Tailwind 3 token setup. Keep the
// browser's native options, keyboard handling and label association.
const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <span data-slot="native-select-wrapper" className="relative inline-flex shrink-0">
    <select
      ref={ref}
      data-slot="native-select"
      className={cn(
        "h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent py-2 ps-3 pe-8 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute end-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  </span>
));
NativeSelect.displayName = "NativeSelect";

export { NativeSelect };
