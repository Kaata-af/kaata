// Original black-and-white artwork, restored byte-for-byte from Git.
// The cache version keeps browsers from showing the former recolored tile.
export function BrandLogo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 overflow-hidden rounded-[22%] bg-brand-primary ${className}`}
    >
      <img src="/logo.png?v=original" alt="" className="block h-full w-full" />
    </span>
  );
}
