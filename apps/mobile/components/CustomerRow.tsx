import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { formatAFN } from "../lib/format";
import type { CustomerWithBalance } from "../lib/types";

export function CustomerRow(props: {
  customer: CustomerWithBalance;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { customer, onPress, onLongPress } = props;
  const balance = customer.balance;
  // Negative balance = customer owes the shopkeeper (red)
  // Positive balance = shopkeeper owes the customer (green)
  const balanceColor =
    balance < 0 ? colors.debt : balance > 0 ? colors.payment : colors.textSecondary;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.left}>
        <Text style={styles.name} numberOfLines={1}>
          {customer.name}
        </Text>
        {customer.phone ? <Text style={styles.phone}>{customer.phone}</Text> : null}
      </View>
      <Text style={[styles.balance, { color: balanceColor }]}>{formatAFN(balance)}</Text>
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
  left: { flex: 1, marginRight: 12 },
  name: { fontSize: 16, fontWeight: "600", color: colors.textPrimary },
  phone: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  balance: { fontSize: 16, fontWeight: "700" },
});
