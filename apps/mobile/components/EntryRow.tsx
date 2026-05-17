import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { formatAFN, formatDate } from "../lib/format";
import type { Entry } from "../lib/types";

export function EntryRow(props: { entry: Entry; onLongPress: () => void }) {
  const { entry } = props;
  const isDebt = entry.type === "debt";
  const color = isDebt ? colors.debt : colors.payment;

  return (
    <Pressable
      onLongPress={props.onLongPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <View style={[styles.bullet, { backgroundColor: color }]} />
      <View style={styles.middle}>
        <View style={styles.amountRow}>
          <Text style={[styles.kind, { color }]}>{isDebt ? "DEBT" : "PAYMENT"}</Text>
          <Text style={[styles.amount, { color }]}>{formatAFN(entry.amount_afn)}</Text>
        </View>
        {entry.note ? (
          <Text style={styles.note} numberOfLines={2}>
            {entry.note}
          </Text>
        ) : null}
      </View>
      <Text style={styles.date}>{formatDate(entry.created_at)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  bullet: { width: 6, height: 36, borderRadius: 3, marginRight: 12 },
  middle: { flex: 1 },
  amountRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  kind: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  amount: { fontSize: 16, fontWeight: "700" },
  note: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  date: { fontSize: 12, color: colors.textSecondary, marginLeft: 12 },
});
