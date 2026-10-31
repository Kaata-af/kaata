// The ledger remains mounted behind this full-page route dialog. Lock its
// document, then restore its position after the browser's native focus return.
export function openWebRouteDialog(dialog: HTMLDialogElement): () => void {
  const document = dialog.ownerDocument;
  const viewport = document.defaultView;
  if (!viewport) return () => {};
  const position = { left: viewport.scrollX, top: viewport.scrollY };
  const previousFocus = document.activeElement as HTMLElement | null;
  const overflow = [document.documentElement, document.body].flatMap((element) =>
    ["overflow-x", "overflow-y"].map((property) => ({
      style: element.style,
      property,
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    })),
  );
  for (const { style, property } of overflow) style.setProperty(property, "hidden", "important");

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    dialog.close();
    if (previousFocus?.isConnected && !dialog.contains(previousFocus)) {
      previousFocus.focus?.({ preventScroll: true });
    }
    for (const { style, property, value, priority } of overflow) {
      if (value) style.setProperty(property, value, priority);
      else style.removeProperty(property);
    }
    viewport.scrollTo({ ...position, behavior: "instant" });
  };

  try {
    dialog.showModal();
    dialog.querySelector<HTMLHeadingElement>("h1")?.focus({ preventScroll: true });
    dialog.scrollTop = 0;
    dialog.scrollLeft = 0;
  } catch (error) {
    close();
    throw error;
  }
  return close;
}
