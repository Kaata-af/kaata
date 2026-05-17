import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { colors } from "../../lib/colors";
import { createCustomer, createEntry, listCustomersWithBalances } from "../../lib/db";
import { formatAFN } from "../../lib/format";
import type { CustomerWithBalance, EntryType } from "../../lib/types";

type Mode =
  | { kind: "select" }
  | { kind: "existing"; customer: CustomerWithBalance }
  | { kind: "new"; name: string; phone: string };

export default function NewEntryScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ customerId?: string; type?: EntryType }>();
  const initialType: EntryType = params.type === "payment" ? "payment" : "debt";
  const lockedToCustomer = Boolean(params.customerId);

  const [customers, setCustomers] = useState<CustomerWithBalance[]>([]);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<Mode>({ kind: "select" });
  const [type, setType] = useState<EntryType>(initialType);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(lockedToCustomer);

  useEffect(() => {
    listCustomersWithBalances().then((list) => {
      setCustomers(list);
      if (params.customerId) {
        const found = list.find((c) => c.id === params.customerId);
        if (found) setMode({ kind: "existing", customer: found });
      }
      setLoading(false);
    });
  }, [params.customerId]);

  const trimmedSearch = search.trim();
  const filtered = useMemo(() => {
    const q = trimmedSearch.toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => c.name.toLowerCase().includes(q));
  }, [customers, trimmedSearch]);
  const showAddNew =
    trimmedSearch.length > 0 &&
    !customers.some((c) => c.name.toLowerCase() === trimmedSearch.toLowerCase());

  async function onSave() {
    if (mode.kind === "select") return;
    const intAmount = parseInt(amount.replace(/[^0-9]/g, ""), 10);
    if (!intAmount || intAmount <= 0) {
      Alert.alert("Enter a valid amount");
      return;
    }
    setBusy(true);
    try {
      let customerId: string;
      if (mode.kind === "existing") {
        customerId = mode.customer.id;
      } else {
        const name = mode.name.trim();
        if (!name) {
          Alert.alert("Customer name required");
          return;
        }
        const result = await createCustomer(name, mode.phone.trim() || null);
        if (!result.ok) {
          if (result.error === "phone_invalid") {
            Alert.alert(
              "Couldn't read that phone number",
              "Leave it blank, or try a format like +93 70 123 4567.",
            );
          } else {
            Alert.alert(
              "Phone already used",
              `${result.existing.name} already has this phone number. Use that customer, or change the number.`,
            );
          }
          return;
        }
        customerId = result.id;
      }
      await createEntry(customerId, type, intAmount, note.trim().slice(0, 100) || null);
      router.back();
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.fillCenter}>
          <ActivityIndicator />
        </View>
      </SafeAreaView>
    );
  }

  if (mode.kind === "select") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>New kaata entry</Text>
          <View style={{ width: 60 }} />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.searchWrap}>
            <Text style={styles.label}>Who is this for?</Text>
            <TextInput
              style={styles.input}
              value={search}
              onChangeText={setSearch}
              placeholder="Search or add new"
              placeholderTextColor={colors.textSecondary}
              autoFocus
            />
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(c) => c.id}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable
                onPress={() => setMode({ kind: "existing", customer: item })}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name}</Text>
                  {item.phone ? <Text style={styles.sub}>{item.phone}</Text> : null}
                </View>
                <Text
                  style={[
                    styles.balance,
                    {
                      color:
                        item.balance < 0
                          ? colors.debt
                          : item.balance > 0
                            ? colors.payment
                            : colors.textSecondary,
                    },
                  ]}
                >
                  {formatAFN(item.balance)}
                </Text>
              </Pressable>
            )}
            ListFooterComponent={
              showAddNew ? (
                <Pressable
                  onPress={() => setMode({ kind: "new", name: trimmedSearch, phone: "" })}
                  style={({ pressed }) => [styles.addNew, pressed && { opacity: 0.6 }]}
                >
                  <Text style={styles.addNewText}>+ Add new customer: "{trimmedSearch}"</Text>
                </Pressable>
              ) : null
            }
            ListEmptyComponent={
              !showAddNew ? (
                <View style={styles.emptyHint}>
                  <Text style={styles.sub}>
                    {customers.length === 0
                      ? "Type a name to add your first customer."
                      : "No customer matches that name."}
                  </Text>
                </View>
              ) : null
            }
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  const displayName = mode.kind === "existing" ? mode.customer.name : mode.name;
  const balance = mode.kind === "existing" ? mode.customer.balance : null;
  const balanceColor =
    balance == null
      ? colors.textSecondary
      : balance < 0
        ? colors.debt
        : balance > 0
          ? colors.payment
          : colors.textSecondary;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>New kaata entry</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.customerCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardLabel}>Customer</Text>
            <Text style={styles.cardName}>{displayName}</Text>
            {balance != null ? (
              <Text style={[styles.cardBalance, { color: balanceColor }]}>
                {formatAFN(balance)}
              </Text>
            ) : (
              <Text style={styles.cardNew}>New customer</Text>
            )}
          </View>
          {!lockedToCustomer ? (
            <Pressable onPress={() => setMode({ kind: "select" })} hitSlop={8}>
              <Text style={styles.changeLink}>Change</Text>
            </Pressable>
          ) : null}
        </View>

        {mode.kind === "new" ? (
          <View style={styles.field}>
            <Text style={styles.label}>WhatsApp number (optional)</Text>
            <TextInput
              style={styles.input}
              value={mode.phone}
              onChangeText={(v) => setMode({ ...mode, phone: v })}
              placeholder="+93..."
              placeholderTextColor={colors.textSecondary}
              keyboardType="phone-pad"
            />
          </View>
        ) : null}

        <View style={styles.field}>
          <Text style={styles.label}>Type</Text>
          <View style={styles.typeRow}>
            <Pressable
              onPress={() => setType("debt")}
              style={[
                styles.typeBtn,
                { backgroundColor: type === "debt" ? colors.debt : colors.surface },
              ]}
            >
              <Text
                style={[styles.typeText, { color: type === "debt" ? "#fff" : colors.textPrimary }]}
              >
                Debt
              </Text>
            </Pressable>
            <View style={{ width: 12 }} />
            <Pressable
              onPress={() => setType("payment")}
              style={[
                styles.typeBtn,
                { backgroundColor: type === "payment" ? colors.payment : colors.surface },
              ]}
            >
              <Text
                style={[
                  styles.typeText,
                  { color: type === "payment" ? "#fff" : colors.textPrimary },
                ]}
              >
                Payment
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Amount (AFN)</Text>
          <TextInput
            style={styles.amountInput}
            value={amount}
            onChangeText={setAmount}
            placeholder="0"
            placeholderTextColor={colors.textSecondary}
            keyboardType="number-pad"
            autoFocus
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Note (optional)</Text>
          <TextInput
            style={styles.input}
            value={note}
            onChangeText={setNote}
            placeholder="آرد و چای"
            placeholderTextColor={colors.textSecondary}
            maxLength={100}
          />
        </View>

        <View style={{ height: 24 }} />
        <Button
          label="Save"
          onPress={onSave}
          variant={type === "debt" ? "debt" : "payment"}
          loading={busy}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cancel: { fontSize: 16, color: colors.textSecondary, minWidth: 60 },
  title: { fontSize: 16, fontWeight: "600", color: colors.textPrimary },
  body: { flex: 1, padding: 24 },
  field: { marginBottom: 16 },
  label: { fontSize: 14, color: colors.textSecondary, marginBottom: 6 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  amountInput: {
    minHeight: 80,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 40,
    fontWeight: "700",
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    textAlign: "center",
  },
  searchWrap: { padding: 24, paddingBottom: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingVertical: 14,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  name: { fontSize: 16, fontWeight: "600", color: colors.textPrimary },
  sub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  balance: { fontSize: 15, fontWeight: "700" },
  addNew: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  addNewText: { fontSize: 15, fontWeight: "600", color: colors.accent },
  emptyHint: { paddingHorizontal: 24, paddingVertical: 24, alignItems: "center" },
  customerCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  cardLabel: { fontSize: 12, color: colors.textSecondary, marginBottom: 2 },
  cardName: { fontSize: 18, fontWeight: "700", color: colors.textPrimary },
  cardBalance: { fontSize: 14, fontWeight: "600", marginTop: 2 },
  cardNew: { fontSize: 14, color: colors.accent, marginTop: 2, fontWeight: "600" },
  changeLink: { fontSize: 14, color: colors.accent, fontWeight: "600" },
  typeRow: { flexDirection: "row" },
  typeBtn: {
    flex: 1,
    minHeight: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  typeText: { fontSize: 16, fontWeight: "600" },
});
