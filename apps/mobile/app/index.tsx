import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BottomSheet } from "../components/BottomSheet";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CustomerRow } from "../components/CustomerRow";
import { EmptyState } from "../components/EmptyState";
import { UpdateBanner } from "../components/UpdateBanner";
import { useAppMeta } from "../lib/app-meta-context";
import { colors } from "../lib/colors";
import { archiveCustomer, getLocalSelf, listCustomersWithBalances } from "../lib/db";
import { formatAFN } from "../lib/format";
import type { CustomerWithBalance, Self } from "../lib/types";

export default function HomeScreen() {
  const router = useRouter();
  const { forceUpdate } = useAppMeta();
  const [self, setSelf] = useState<Self | null>(null);
  const [customers, setCustomers] = useState<CustomerWithBalance[]>([]);
  const [sheetFor, setSheetFor] = useState<CustomerWithBalance | null>(null);
  const [confirmDeleteFor, setConfirmDeleteFor] = useState<CustomerWithBalance | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [s, list] = await Promise.all([getLocalSelf(), listCustomersWithBalances()]);
    setSelf(s);
    setCustomers(list);
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (forceUpdate) return <Redirect href="/update-prompt" />;
  // Belt-and-suspenders alongside Stack.initialRouteName: if no local-self user
  // exists yet, we have to send the user to onboarding. initialRouteName alone
  // isn't enough — the OS opens the app at "/" which renders this screen
  // regardless of stack root.
  if (loaded && !self) return <Redirect href="/onboarding" />;

  const totalOwed = customers.reduce((sum, c) => sum + (c.balance < 0 ? -c.balance : 0), 0);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.identity}>
          <Text style={styles.name} numberOfLines={1}>
            {self?.name ?? "Kaata"}
          </Text>
          {self?.shop_name ? (
            <Text style={styles.shopName} numberOfLines={1}>
              {self.shop_name}
            </Text>
          ) : null}
        </View>
        <Text style={styles.totalLabel}>Total owed to you</Text>
        <Text style={styles.totalValue}>{formatAFN(totalOwed)}</Text>
      </View>

      <UpdateBanner />

      <FlatList
        data={customers}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => (
          <CustomerRow
            customer={item}
            onPress={() => router.push(`/customer/${item.id}`)}
            onLongPress={() => setSheetFor(item)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            title="No kaatas yet"
            subtitle="Tap + to record your first debt or payment."
          />
        }
        contentContainerStyle={
          customers.length === 0 ? { flexGrow: 1, justifyContent: "center" } : undefined
        }
      />

      <Pressable onPress={() => router.push("/entry/new")} style={styles.fab}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>

      <BottomSheet
        visible={sheetFor !== null}
        title={sheetFor?.name}
        onDismiss={() => setSheetFor(null)}
        actions={[
          {
            label: "Edit",
            icon: "create-outline",
            onPress: () => {
              const id = sheetFor?.id;
              if (id) router.push(`/customer/${id}/edit`);
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
        title={`Delete ${confirmDeleteFor?.name ?? ""}?`}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (confirmDeleteFor) {
            await archiveCustomer(confirmDeleteFor.id);
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
  header: { paddingHorizontal: 24, paddingTop: 16, paddingBottom: 20 },
  identity: { marginBottom: 20 },
  name: { fontSize: 17, fontWeight: "600", color: colors.textPrimary },
  shopName: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  totalLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  totalValue: {
    fontSize: 40,
    fontWeight: "700",
    color: colors.textPrimary,
    marginTop: 4,
  },
  fab: {
    position: "absolute",
    bottom: 24,
    right: 24,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.primaryAction,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  fabText: { color: "#fff", fontSize: 32, lineHeight: 34, fontWeight: "300" },
});
