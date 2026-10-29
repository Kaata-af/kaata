import type { ReactNode } from "react";
import { SettledHistoryToggle } from "./SettledHistoryToggle";

/** Settled customers stay below active accounts in the same scroll container. */
export function SettledAccountsSection({
  expanded,
  onToggle,
  count,
  children,
  disabled = false,
}: {
  expanded: boolean;
  onToggle: () => void;
  count: number;
  children: ReactNode;
  disabled?: boolean;
}) {
  if (count <= 0) return null;
  return (
    <>
      <SettledHistoryToggle
        kind="accounts"
        count={count}
        expanded={expanded}
        disabled={disabled}
        onToggle={onToggle}
        horizontalInset={16}
      />
      {expanded ? children : null}
    </>
  );
}
