// Preserve the original logo's exact artwork. Screen blending turns its black
// tile aubergine, keeps the K white and avoids replacing it with a traced mask.
export function BrandLogo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`isolate inline-flex shrink-0 overflow-hidden rounded-[22%] bg-brand-primary ${className}`}
    >
      <img src="/logo.png" alt="" className="block h-full w-full mix-blend-screen" />
    </span>
  );
}
