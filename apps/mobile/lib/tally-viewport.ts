/** Leave visible tallies alone; center an offscreen target in the usable area.
 * Coordinates are in ScrollView content space. The floating action bar/toast
 * covers the bottom of the viewport and must not hide the target. */
export function tallyScrollTarget({
  top,
  height,
  offset,
  viewport,
  bottomInset,
}: {
  top: number;
  height: number;
  offset: number;
  viewport: number;
  bottomInset: number;
}): number | null {
  const visibleHeight = Math.max(0, viewport - bottomInset);
  if (visibleHeight <= 0 || height <= 0) return null;
  const margin = Math.min(16, visibleHeight / 4);
  const visibleTop = offset + margin;
  const visibleBottom = offset + visibleHeight - margin;
  if (top >= visibleTop && top + height <= visibleBottom) return null;
  // A long expanded note may fill the viewport. If its beginning is already
  // visible, don't jump while the user is reading it.
  if (
    height > visibleHeight - 2 * margin &&
    top < visibleBottom - margin &&
    top + height >= visibleBottom
  )
    return null;
  return Math.max(0, top - Math.max(margin, (visibleHeight - height) / 2));
}
