import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";
import { formatAmount, formatRelative } from "../lib/format";
import type { PersonWithBalance } from "../lib/types";

// Stacked-card list row. Designed to live inside a rounded container with
// borderWidth:1 and divider Views between rows.
//
// `balance` is signed at the type level but the row always shows the absolute
// amount — direction is conveyed by the active tab, not by the row.
export function PersonRow(props: {
  person: PersonWithBalance;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { person } = props;
  const abs = Math.abs(person.balance);
  const subtitle = !person.last_entry_at
    ? "no entries yet"
    : person.balance === 0
      ? "settled"
      : formatRelative(person.last_entry_at);

  return (
    <Pressable
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.bgMuted }]}
    >
      <View style={styles.left}>
        <Text style={styles.name} numberOfLines={1}>
          {person.name}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <View style={styles.right}>
        <Text style={[styles.amount, abs === 0 && { color: colors.textMuted }]}>
          {formatAmount(abs)}
        </Text>
        <Text style={styles.afn}>AFN</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.bgDefault,
  },
  left: { flex: 1, marginRight: 12 },
  name: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
  },
  sub: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 2,
  },
  right: { flexDirection: "row", alignItems: "baseline", gap: 4 },
  amount: {
    fontSize: 15,
    fontFamily: fonts.monoSemi,
    color: colors.textEmphasis,
  },
  afn: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
    color: colors.textMuted,
  },
});
