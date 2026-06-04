import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { getCurrentCurrencySymbol } from "../lib/currency";
import { rowDir, textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { formatAmount, formatRelative } from "../lib/format";
import { t } from "../lib/i18n";
import type { Entry } from "../lib/types";

// type='debt'    → value left my hand  → "I gave"   → up arrow
// type='payment' → value came to me    → "I received" → down arrow
// Same in both directions; the row doesn't need to know which tab it lives in.
export function EntryRow(props: { entry: Entry; onPress: () => void }) {
  const isRTL = useIsRTL();
  const { entry } = props;
  const isGave = entry.type === "debt";
  const icon = isGave ? "arrow-up-outline" : "arrow-down-outline";
  const verb = isGave ? t("person.action.iGave") : t("person.action.iReceived");

  return (
    <Pressable
      onPress={props.onPress}
      // Same handler on long-press with a short delay so a sustained finger
      // press opens the sheet *while still holding*, not only on release.
      // Pressable cancels the press if the finger moves enough to start a
      // scroll, so this doesn't fight the list's vertical scroll gesture.
      onLongPress={props.onPress}
      delayLongPress={100}
      style={({ pressed }) => [
        styles.row,
        rowDir(isRTL),
        pressed && { backgroundColor: colors.bgMuted },
      ]}
    >
      <View style={[styles.iconWrap, isRTL ? styles.iconWrapRTL : styles.iconWrapLTR]}>
        <Ionicons name={icon} size={16} color={colors.textDefault} />
      </View>
      <View style={styles.middle}>
        <View style={[styles.amountRow, rowDir(isRTL)]}>
          <Text style={styles.amount}>{formatAmount(entry.amount_afn)}</Text>
          <Text style={styles.afn}>{getCurrentCurrencySymbol()}</Text>
        </View>
        <View style={[styles.metaRow, rowDir(isRTL)]}>
          <Text style={styles.verb}>{verb}</Text>
          <Text style={styles.dot}>·</Text>
          <Text style={styles.when}>{formatRelative(entry.created_at)}</Text>
          {entry.note ? (
            <>
              <Text style={styles.dot}>·</Text>
              <Text style={[styles.note, textDir(isRTL)]} numberOfLines={1}>
                {entry.note}
              </Text>
            </>
          ) : null}
        </View>
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
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.bgSubtle,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrapLTR: { marginRight: 12 },
  iconWrapRTL: { marginLeft: 12 },
  middle: { flex: 1 },
  amountRow: { flexDirection: "row", alignItems: "baseline", gap: 4 },
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
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 2,
    flexWrap: "wrap",
  },
  verb: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
  },
  dot: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textMuted,
    marginHorizontal: 5,
  },
  when: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
  },
  note: {
    flex: 1,
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
  },
});
