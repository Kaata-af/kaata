import { useCallback, useEffect, useMemo, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { colors } from "../lib/colors";
import type { PersonWithBalance } from "../lib/types";
import type { personSharedAccountStatus } from "../lib/tabs/link-status";
import type { CreditStatus } from "./CreditStatusBadge";
import { PersonRow } from "./PersonRow";

export type CustomerRowsProps = {
  people: PersonWithBalance[];
  creditByPerson: Record<string, CreditStatus>;
  sharedStatusByPerson: Record<string, ReturnType<typeof personSharedAccountStatus>>;
  onPersonPress: (person: PersonWithBalance) => void;
  onPersonLongPress?: (person: PersonWithBalance) => void;
  selecting?: boolean;
  selectedIds?: ReadonlySet<string>;
  selectionBusy?: boolean;
  showDirection?: boolean;
};

type RowLease = { scope: string; ids: string[]; alive: boolean };

/** Android keeps only previously shown rows in this list's current universe.
 * Filtering can then reveal the existing native text views instead of creating
 * the whole list again. Hidden rows take no layout space or input. */
export function CustomerRows({
  retained,
  separated,
  ...props
}: CustomerRowsProps & {
  separated?: boolean;
  /** Home passes the complete, current active-account set, before filtering. */
  retained?: { scope: string; people: readonly PersonWithBalance[] };
}) {
  const reuse = Platform.OS === "android" && retained !== undefined;
  const scope = reuse ? retained.scope : "";
  const owner = useRef<RowLease>({ scope, ids: [], alive: true });
  if (owner.current.scope !== scope) owner.current = { scope, ids: [], alive: true };
  const lease = owner.current;
  useEffect(() => {
    lease.alive = true;
    return () => {
      lease.alive = false;
    };
  }, [lease]);

  const rows = useMemo(() => {
    if (!reuse) return props.people.map((person) => ({ person, hidden: false }));
    // The universe is authoritative for deletion and active/settled movement.
    // Visible rows retain their currency-filter projection; hidden rows always
    // read the latest complete record, never a previous ledger snapshot.
    const universe = new Map(retained.people.map((person) => [person.id, person]));
    const visible = new Map(
      props.people.filter((person) => universe.has(person.id)).map((person) => [person.id, person]),
    );
    const ids = [
      ...visible.keys(),
      ...lease.ids.filter((id) => !visible.has(id) && universe.has(id)),
    ];
    lease.ids = ids;
    return ids.map((id) => ({
      person: visible.get(id) ?? universe.get(id)!,
      hidden: !visible.has(id),
    }));
  }, [props.people, retained?.people, reuse, lease]);
  const visiblePeople = useMemo(
    () => new Map(rows.filter((row) => !row.hidden).map((row) => [row.person.id, row.person])),
    [rows],
  );
  const latest = useRef({ lease, visiblePeople, props });
  latest.current = { lease, visiblePeople, props };
  const press = useCallback(
    (person: PersonWithBalance) => {
      const current = latest.current;
      if (!lease.alive || current.lease !== lease || current.props.selectionBusy) return;
      const visible = current.visiblePeople.get(person.id);
      if (visible) current.props.onPersonPress(visible);
    },
    [lease],
  );
  const longPress = useCallback(
    (person: PersonWithBalance) => {
      const current = latest.current;
      if (!lease.alive || current.lease !== lease || current.props.selectionBusy) return;
      const visible = current.visiblePeople.get(person.id);
      if (visible) current.props.onPersonLongPress?.(visible);
    },
    [lease],
  );
  const content = useMemo(() => {
    let visibleIndex = 0;
    return rows.map(({ person, hidden }) => {
      const divider = !hidden && visibleIndex++ > 0;
      // Visibility belongs to this wrapper and the live callback lease. Keep
      // it out of PersonRow's props so a filter can hide/reveal an unchanged
      // memoized row without rebuilding its text and currency descendants.
      return (
        <View
          key={person.id}
          testID={`home-customer-row-${person.id}`}
          style={hidden ? styles.hidden : undefined}
          pointerEvents={hidden ? "none" : "auto"}
          accessibilityElementsHidden={hidden}
          importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
        >
          {divider ? <View style={styles.divider} /> : null}
          <PersonRow
            person={person}
            creditStatus={props.creditByPerson[person.id] ?? "none"}
            sharedStatus={props.sharedStatusByPerson[person.id]}
            onPress={reuse ? press : props.onPersonPress}
            onLongPress={
              props.onPersonLongPress ? (reuse ? longPress : props.onPersonLongPress) : undefined
            }
            selecting={props.selecting}
            selected={props.selecting && props.selectedIds?.has(person.id)}
            disabled={props.selectionBusy}
            showDirection={props.showDirection}
          />
        </View>
      );
    });
  }, [
    rows,
    props.creditByPerson,
    props.sharedStatusByPerson,
    props.onPersonPress,
    props.onPersonLongPress,
    props.selecting,
    props.selectedIds,
    props.selectionBusy,
    props.showDirection,
    reuse,
    press,
    longPress,
  ]);
  return (
    <View
      testID={retained ? "home-active-customer-rows" : undefined}
      style={[
        styles.peopleCard,
        separated && styles.separatedPeopleCard,
        reuse && visiblePeople.size === 0 && styles.hidden,
      ]}
      pointerEvents={reuse && visiblePeople.size === 0 ? "none" : "auto"}
      accessibilityElementsHidden={reuse && visiblePeople.size === 0}
      importantForAccessibility={reuse && visiblePeople.size === 0 ? "no-hide-descendants" : "auto"}
    >
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  peopleCard: {
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
  },
  separatedPeopleCard: { marginTop: 16 },
  divider: { height: 1, backgroundColor: colors.borderDefault },
  hidden: { display: "none" },
});
