// The logo PNG is the original artwork recolored per pixel to Aubergine
// (marketing/recolor_logo.py), so it renders as-is. The tile keeps the 22%
// corner and an Aubergine fill while the image loads. `?v=aubergine` keeps a
// browser from pairing this markup with a cached copy of the old black file.
export function BrandLogo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 overflow-hidden rounded-[22%] bg-brand-primary ${className}`}
    >
      <img src="/logo.png?v=aubergine" alt="" className="block h-full w-full" />
    </span>
  );
}
