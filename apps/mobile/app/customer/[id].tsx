import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomSheet } from "../../components/BottomSheet";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { EntryRow } from "../../components/EntryRow";
import { colors } from "../../lib/colors";
import { getCustomer, getLocalSelf, listEntries, softDeleteEntry } from "../../lib/db";
import { formatAFN } from "../../lib/format";
import { sharekaataViaWhatsApp } from "../../lib/share";
import type { CustomerWithBalance, Entry, Self } from "../../lib/types";

export default function CustomerDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [customer, setCustomer] = useState<CustomerWithBalance | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [self, setSelf] = useState<Self | null>(null);
  const [sheetFor, setSheetFor] = useState<Entry | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<Entry | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const [c, list, s] = await Promise.all([getCustomer(id), listEntries(id), getLocalSelf()]);
    setCustomer(c);
    setEntries(list);
    setSelf(s);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!customer) {
    return (
      <SafeAreaView style={styles.container}>
        <View />
      </SafeAreaView>
    );
  }

  const balance = customer.balance;
  const balanceColor =
    balance < 0 ? colors.debt : balance > 0 ? colors.payment : colors.textSecondary;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons name="chevron-back" size={26} color={colors.textPrimary} />
        </Pressable>
        <Pressable
          onPress={() => router.push(`/customer/${customer.id}/edit`)}
          hitSlop={8}
          style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
        >
          <Ionicons name="create-outline" size={22} color={colors.textPrimary} />
        </Pressable>
      </View>

      <View style={styles.info}>
        <Text style={styles.name}>{customer.name}</Text>
        {customer.phone ? <Text style={styles.phone}>{customer.phone}</Text> : null}
        <Text style={[styles.balance, { color: balanceColor }]}>{formatAFN(balance)}</Text>
      </View>

      <View style={styles.actions}>
        <View style={{ flex: 1, marginRight: 8 }}>
          <Button
            label="Add Debt"
            variant="debt"
            onPress={() =>
              router.push({
                pathname: "/entry/new",
                params: { customerId: customer.id, type: "debt" },
              })
            }
          />
        </View>
        <View style={{ flex: 1, marginLeft: 8 }}>
          <Button
            label="Add Payment"
            variant="payment"
            onPress={() =>
              router.push({
                pathname: "/entry/new",
                params: { customerId: customer.id, type: "payment" },
              })
            }
          />
        </View>
      </View>

      <FlatList
        data={entries}
        keyExtractor={(e) => e.id}
        renderItem={({ item }) => <EntryRow entry={item} onLongPress={() => setSheetFor(item)} />}
        ListEmptyComponent={
          <EmptyState title="No entries yet" subtitle="Add a debt or payment to begin." />
        }
        contentContainerStyle={{ paddingBottom: 96 + insets.bottom }}
      />

      <View
        style={[styles.sendFloat, { paddingBottom: 16 + insets.bottom }]}
        pointerEvents="box-none"
      >
        <Pressable
          onPress={() =>
            sharekaataViaWhatsApp({ name: customer.name, phone: customer.phone }, balance, self)
          }
          style={({ pressed }) => [styles.sendBtn, pressed && { opacity: 0.9 }]}
        >
          <Ionicons name="logo-whatsapp" size={18} color="#FFFFFF" />
          <Text style={styles.sendLabel}>Send via WhatsApp</Text>
        </Pressable>
      </View>

      <BottomSheet
        visible={sheetFor !== null}
        title={
          sheetFor
            ? `${sheetFor.type === "debt" ? "Debt" : "Payment"} of ${formatAFN(sheetFor.amount_afn)}`
            : undefined
        }
        onDismiss={() => setSheetFor(null)}
        actions={[
          {
            label: "Edit",
            icon: "create-outline",
            onPress: () => {
              const id = sheetFor?.id;
              if (id) router.push(`/entry/${id}/edit`);
            },
          },
          {
            label: "Delete",
            icon: "trash-outline",
            destructive: true,
            onPress: () => setConfirmDeleteFor(sheetFor),
          },
        ]}
      />

      <ConfirmDialog
        visible={confirmDeleteFor !== null}
        title={
          confirmDeleteFor
            ? `Delete this ${confirmDeleteFor.type === "debt" ? "debt" : "payment"}?`
            : ""
        }
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (confirmDeleteFor) {
            await softDeleteEntry(confirmDeleteFor.id);
            await load();
          }
        }}
        onCancel={() => setConfirmDeleteFor(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  sendFloat: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingHorizontal: 16,
  },
  sendBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: colors.whatsapp,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    elevation: 6,
  },
  sendLabel: { color: "#FFFFFF", fontWeight: "600", fontSize: 15 },
  info: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 16 },
  name: { fontSize: 28, fontWeight: "700", color: colors.textPrimary },
  phone: { fontSize: 14, color: colors.textSecondary, marginTop: 4 },
  balance: { fontSize: 40, fontWeight: "700", marginTop: 12 },
  actions: { flexDirection: "row", paddingHorizontal: 16, paddingBottom: 16 },
});
