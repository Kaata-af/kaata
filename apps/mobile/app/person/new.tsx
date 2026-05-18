import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { colors } from "../../lib/colors";
import { createPerson, listAllPeople } from "../../lib/db";
import { fonts } from "../../lib/fonts";
import { formatAmount } from "../../lib/format";
import { hasExactMatch, searchPeople } from "../../lib/search";
import type { PersonWithBalance } from "../../lib/types";

// Hybrid add-or-find: the name field doubles as a live fuzzy search. Existing
// matches surface inline; the WhatsApp field appears as soon as the typed
// name doesn't exactly match anyone (i.e. you're in create-mode), so phone
// is collected up-front instead of being deferred to the edit screen.
export default function PersonAddOrFindScreen() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [people, setPeople] = useState<PersonWithBalance[] | null>(null);
  const [busy, setBusy] = useState(false);
  const phoneRef = useRef<TextInput>(null);

  useEffect(() => {
    listAllPeople().then(setPeople);
  }, []);

  const trimmed = name.trim();
  const results = useMemo(() => (people ? searchPeople(name, people) : []), [people, name]);
  const exact = useMemo(() => (people ? hasExactMatch(name, people) : undefined), [people, name]);
  const isCreating = trimmed.length > 0 && !exact;

  function openPerson(id: string) {
    router.replace({ pathname: "/person/[id]", params: { id } });
  }

  async function createAndOpen() {
    if (busy || !trimmed || people === null) return;
    setBusy(true);
    try {
      const result = await createPerson(trimmed, phone.trim() || null);
      if (!result.ok) {
        if (result.error === "phone_invalid") {
          Alert.alert(
            "Couldn't read that phone number",
            "Leave it blank, or try a format like +93 70 123 4567.",
          );
        } else if (result.error === "phone_conflict") {
          Alert.alert(
            "Phone already in use",
            `${result.existing.name} already has this number. Use a different one, or open ${result.existing.name} from the matches above.`,
          );
        }
        return;
      }
      openPerson(result.id);
    } catch (e) {
      Alert.alert("Couldn't add person", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Name Done key:
  //   exact match  → open that person
  //   creating     → advance to phone field
  //   empty        → no-op
  function onNameSubmit() {
    if (!people) return;
    if (exact) {
      openPerson(exact.id);
    } else if (trimmed.length > 0) {
      phoneRef.current?.focus();
    }
  }

  const showRecentOrMatches = results.length > 0;
  const showNoMatchesText = !showRecentOrMatches && trimmed.length > 0 && people !== null;
  const showEmptyState = people !== null && people.length === 0 && trimmed.length === 0;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Add or find person</Text>
        <View style={{ width: 60 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}
        >
          <View style={styles.field}>
            <Text style={styles.label}>
              Name <Text style={styles.required}>*</Text>
            </Text>
            <View style={styles.inputWrap}>
              <TextInput
                style={styles.inputInner}
                value={name}
                onChangeText={setName}
                placeholder="Type to search or add"
                placeholderTextColor={colors.textMuted}
                autoFocus
                autoCorrect={false}
                autoCapitalize="words"
                returnKeyType={exact ? "go" : trimmed.length > 0 ? "next" : "default"}
                onSubmitEditing={onNameSubmit}
                submitBehavior="submit"
              />
              {name.length > 0 ? (
                <Pressable onPress={() => setName("")} hitSlop={8} style={styles.clearBtn}>
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                </Pressable>
              ) : null}
            </View>
          </View>

          {people === null ? (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.textDefault} />
            </View>
          ) : null}

          {showEmptyState ? (
            <View style={styles.emptyHint}>
              <Text style={styles.emptyTitle}>No one here yet</Text>
              <Text style={styles.emptySub}>Type a name above to add your first person.</Text>
            </View>
          ) : null}

          {showRecentOrMatches ? (
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{trimmed.length > 0 ? "Matches" : "Recent"}</Text>
              <View style={styles.list}>
                {results.map((p, i) => (
                  <View key={p.id}>
                    <Pressable
                      onPress={() => openPerson(p.id)}
                      style={({ pressed }) => [
                        styles.row,
                        pressed && { backgroundColor: colors.bgMuted },
                      ]}
                    >
                      <View style={styles.rowLeft}>
                        <Text style={styles.rowName} numberOfLines={1}>
                          {p.name}
                        </Text>
                        <Text style={styles.rowSub} numberOfLines={1}>
                          {p.phone ?? "no phone"}
                        </Text>
                      </View>
                      <RightAmount balance={p.balance} hasEntries={p.last_entry_at !== null} />
                    </Pressable>
                    {i < results.length - 1 ? <View style={styles.divider} /> : null}
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          {showNoMatchesText ? (
            <View style={styles.noMatchSection}>
              <Text style={styles.noMatchText}>No one matches &ldquo;{trimmed}&rdquo;.</Text>
            </View>
          ) : null}

          {isCreating ? (
            <>
              <View style={styles.field}>
                <Text style={styles.label}>WhatsApp number</Text>
                <TextInput
                  ref={phoneRef}
                  style={styles.input}
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="+93..."
                  placeholderTextColor={colors.textMuted}
                  keyboardType="phone-pad"
                  returnKeyType="done"
                  onSubmitEditing={createAndOpen}
                />
                <Text style={styles.fieldHint}>Needed to send pings on WhatsApp.</Text>
              </View>

              <View style={{ height: 8 }} />
              <Button label={`Add ${trimmed}`} onPress={createAndOpen} loading={busy} />
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// Right-aligned amount cell — uses + / − prefix to convey direction without
// breaking the monochrome palette.
function RightAmount(props: { balance: number; hasEntries: boolean }) {
  if (!props.hasEntries) {
    return <Text style={styles.rightMuted}>new</Text>;
  }
  if (props.balance === 0) {
    return <Text style={styles.rightMuted}>settled</Text>;
  }
  const sign = props.balance > 0 ? "+" : "−";
  return (
    <View style={styles.rightAmountRow}>
      <Text style={styles.rightSign}>{sign}</Text>
      <Text style={styles.rightAmount}>{formatAmount(props.balance)}</Text>
      <Text style={styles.rightAfn}>AFN</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefault,
  },
  cancel: { fontSize: 15, fontFamily: fonts.sansMedium, color: colors.textSubtle, minWidth: 60 },
  title: { fontSize: 15, fontFamily: fonts.sansSemi, color: colors.textEmphasis },

  scrollContent: { padding: 16, paddingBottom: 32 },

  field: { marginBottom: 16 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  required: { color: colors.danger },
  fieldHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 6,
  },

  // Single-line bordered input (matches the rest of the app's text inputs).
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
    backgroundColor: colors.bgDefault,
  },
  // Wrapper that holds the input + inline clear button (name field only).
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    backgroundColor: colors.bgDefault,
    paddingRight: 6,
  },
  inputInner: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: fonts.sansRegular,
    color: colors.textEmphasis,
  },
  clearBtn: { padding: 6 },

  centered: { alignItems: "center", paddingVertical: 16 },

  emptyHint: { paddingTop: 8, paddingBottom: 12, alignItems: "center" },
  emptyTitle: { fontSize: 14, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  emptySub: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 4,
    textAlign: "center",
  },

  section: { marginBottom: 16 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  list: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
  },
  divider: { height: 1, backgroundColor: colors.borderDefault },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowLeft: { flex: 1, marginRight: 12 },
  rowName: { fontSize: 15, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  rowSub: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 2,
  },

  rightAmountRow: { flexDirection: "row", alignItems: "baseline", gap: 2 },
  rightSign: {
    fontSize: 14,
    fontFamily: fonts.monoMedium,
    color: colors.textDefault,
    marginRight: 2,
  },
  rightAmount: { fontSize: 14, fontFamily: fonts.monoSemi, color: colors.textEmphasis },
  rightAfn: {
    fontSize: 11,
    fontFamily: fonts.sansMedium,
    color: colors.textMuted,
    marginLeft: 2,
  },
  rightMuted: { fontSize: 12, fontFamily: fonts.sansMedium, color: colors.textMuted },

  noMatchSection: { paddingVertical: 4, marginBottom: 8 },
  noMatchText: { fontSize: 13, fontFamily: fonts.sansRegular, color: colors.textSubtle },
});
