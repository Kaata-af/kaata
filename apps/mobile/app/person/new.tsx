import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { ContactsPickerSheet, type PickedContact } from "../../components/ContactsPickerSheet";
import { CountryPickerSheet } from "../../components/CountryPickerSheet";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import { getCurrentCurrencySymbol } from "../../lib/currency";
import { createPerson, getActiveVaultArchivedState, listAllPeopleForSearch } from "../../lib/db";
import { toAsciiDigits } from "../../lib/digits";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../../lib/event-log";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { formatAmount } from "../../lib/format";
import { t } from "../../lib/i18n";
import { getCountry, getCurrentDefaultCountryCode, inferCountryFromE164 } from "../../lib/phone";
import { hasExactMatch, searchPeople } from "../../lib/search";
import type { PersonWithBalance } from "../../lib/types";

// Hybrid add-or-find: the name field doubles as a live fuzzy search. Existing
// matches surface inline; the WhatsApp field appears as soon as the typed
// name doesn't exactly match anyone (i.e. you're in create-mode), so phone
// is collected up-front instead of being deferred to the edit screen.
export default function PersonAddOrFindScreen() {
  const router = useRouter();
  const toast = useToast();
  // Subscribes to locale changes — flipping language in Settings live-updates
  // this screen if it happens to be focused; otherwise the screen mounts
  // fresh on next nav and picks up the new locale anyway.
  const isRTL = useIsRTL();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // Initial country defaults to the user's preference (set in Preferences).
  // Module-global was hydrated during _layout init, so this is synchronously
  // correct on mount. The picker can still be changed per-entry.
  const [countryCode, setCountryCode] = useState(getCurrentDefaultCountryCode);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [contactsVisible, setContactsVisible] = useState(false);
  const [people, setPeople] = useState<PersonWithBalance[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Inline errors — modal screen, toasts can't render above it (Toast.tsx).
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const nameRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  // Synchronous re-entry guard — `busy` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx.
  const savingRef = useRef(false);
  const country = getCountry(countryCode);

  // Pulls a name + phone from the device's contacts picker. If the phone is
  // E.164-shaped (starts with +), we also infer the country and strip the
  // dial code so the picker UI is consistent.
  function onContactPicked(c: PickedContact) {
    setName(c.name);
    setPhoneError(null);
    if (c.phone) {
      // Contacts saved from a Persian keyboard can carry Persian/Arabic-
      // Indic digits — transliterate before any ASCII-digit matching.
      const rawPhone = toAsciiDigits(c.phone.trim());
      if (rawPhone.startsWith("+")) {
        const inferred = inferCountryFromE164(rawPhone);
        const dial = getCountry(inferred).dialCode;
        setCountryCode(inferred);
        setPhone(rawPhone.startsWith(dial) ? rawPhone.slice(dial.length).trim() : rawPhone);
      } else {
        // National-format number; leave the user's selected country alone
        // and just drop the leading 0 if present (Afghan trunk prefix).
        const cleaned = rawPhone.replace(/[^\d]/g, "");
        setPhone(cleaned.startsWith("0") ? cleaned.slice(1) : cleaned);
      }
    } else {
      setPhone("");
    }
  }

  // D-DEFENSIVE-ARCHIVED-GUARD: see entry/new.tsx for rationale.
  // A mesh-sourced vault_setting_set can land between home's load() and
  // this screen's mount; bail before any DB write can be attempted.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const guard = await getActiveVaultArchivedState();
      if (cancelled) return;
      if (guard.state === "none") {
        toast.push(t("entry.noActiveVault"), "error");
        router.replace("/");
        return;
      }
      if (guard.state === "archived") {
        toast.push(t("entry.vaultArchived"), "error");
        router.replace("/vault/archived");
        return;
      }
      // Search/add must find people with ZERO tallies too (home hides them).
      const list = await listAllPeopleForSearch();
      if (cancelled) return;
      setPeople(list);
    })();
    return () => {
      cancelled = true;
    };
    // toast/router/t are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the name field via ref + delay, NOT autoFocus: on a stack-modal screen
  // autoFocus fires before the slide-in finishes, so focus succeeds but the soft
  // keyboard never opens on Android (the user has to tap the field again). 280ms
  // clears the modal animation. (Same pattern the edit screens use — see CLAUDE.md.)
  useEffect(() => {
    const tmr = setTimeout(() => nameRef.current?.focus(), 280);
    return () => clearTimeout(tmr);
  }, []);

  const trimmed = name.trim();
  const results = useMemo(() => (people ? searchPeople(name, people) : []), [people, name]);
  // Cap the rendered matches — this list lives inside a ScrollView (no
  // virtualization possible without restructuring the form) and an empty
  // query returns the entire book. Typing narrows; 30 rows is plenty.
  const visibleResults = useMemo(() => results.slice(0, 30), [results]);
  const hiddenResultCount = results.length - visibleResults.length;
  const exact = useMemo(() => (people ? hasExactMatch(name, people) : undefined), [people, name]);
  const isCreating = trimmed.length > 0 && !exact;

  function openPerson(id: string) {
    router.replace({ pathname: "/person/[id]", params: { id } });
  }

  async function createAndOpen() {
    if (savingRef.current || !trimmed || people === null) return;
    savingRef.current = true;
    setBusy(true);
    setPhoneError(null);
    setSaveError(null);
    try {
      // Re-check at submit time in case a mesh archive landed mid-screen.
      const guard = await getActiveVaultArchivedState();
      if (guard.state === "none") {
        toast.push(t("entry.noActiveVault"), "error");
        router.replace("/");
        return;
      }
      if (guard.state === "archived") {
        toast.push(t("entry.vaultArchived"), "error");
        router.replace("/vault/archived");
        return;
      }
      const result = await createPerson(trimmed, phone.trim() || null, countryCode);
      if (!result.ok) {
        if (result.error === "phone_invalid") {
          setPhoneError(t("personAdd.phone.invalid"));
        } else if (result.error === "phone_conflict") {
          setPhoneError(t("personAdd.phone.conflict", { name: result.existing.name }));
        }
        return;
      }
      openPerson(result.id);
    } catch (err) {
      // Mythos Fix Set C: distinguish the signing-unavailable failure
      // (Fix Set A's new throw) from generic storage errors so the user
      // gets an actionable message ("reopen the app") instead of the
      // opaque "Couldn't save."
      if (err instanceof EventSigningUnavailableError) {
        setSaveError(t("entry.signingUnavailable"));
      } else if (err instanceof RoleGateRejectionError) {
        setSaveError(t("entry.roleDenied"));
      } else {
        setSaveError(t("entry.saveFailed"));
      }
    } finally {
      savingRef.current = false;
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
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.cancel, textDir(isRTL)]}>{t("common.cancel")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("personAdd.title")}</Text>
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
            <Text style={[styles.label, textDir(isRTL)]}>
              {t("personEdit.name.label")} <Text style={styles.required}>*</Text>
            </Text>
            <View style={styles.inputWrap}>
              <TextInput
                ref={nameRef}
                style={[styles.inputInner, textDir(isRTL)]}
                value={name}
                onChangeText={setName}
                placeholder={t("personAdd.name.placeholder")}
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={t("personEdit.name.label")}
                autoCorrect={false}
                autoCapitalize="words"
                maxLength={50}
                returnKeyType={exact ? "go" : trimmed.length > 0 ? "next" : "default"}
                onSubmitEditing={onNameSubmit}
                submitBehavior="submit"
              />
              {name.length > 0 ? (
                <Pressable
                  onPress={() => setName("")}
                  hitSlop={8}
                  style={styles.clearBtn}
                  accessibilityRole="button"
                  accessibilityLabel={t("common.cancel")}
                >
                  <Ionicons name="close-circle" size={18} color={colors.textMuted} />
                </Pressable>
              ) : null}
            </View>
            <Pressable
              onPress={() => setContactsVisible(true)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.pickFromContacts,
                rowDir(isRTL),
                // alignSelf must be picked at render-time because we've
                // disabled Yoga's RTL handling (allowRTL(false)); flex-start
                // no longer resolves to the script's start edge, it's always
                // physical left.
                { alignSelf: isRTL ? "flex-end" : "flex-start" },
                pressed && { opacity: 0.6 },
              ]}
            >
              <Ionicons name="person-circle-outline" size={16} color={colors.textSubtle} />
              <Text style={styles.pickFromContactsText}>{t("personAdd.pickContact")}</Text>
              <Ionicons
                name={isRTL ? "chevron-back" : "chevron-forward"}
                size={14}
                color={colors.textMuted}
              />
            </Pressable>
          </View>

          {people === null ? (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.textDefault} />
            </View>
          ) : null}

          {showEmptyState ? (
            <View style={styles.emptyHint}>
              <Text style={styles.emptyTitle}>{t("personAdd.empty.title")}</Text>
              <Text style={styles.emptySub}>{t("personAdd.empty.subtitle")}</Text>
            </View>
          ) : null}

          {showRecentOrMatches ? (
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, textDir(isRTL)]}>
                {trimmed.length > 0
                  ? t("personAdd.section.matches")
                  : t("personAdd.section.recent")}
              </Text>
              <View style={styles.list}>
                {visibleResults.map((p, i) => (
                  <View key={p.id}>
                    <Pressable
                      onPress={() => openPerson(p.id)}
                      style={({ pressed }) => [
                        styles.row,
                        rowDir(isRTL),
                        pressed && { backgroundColor: colors.bgMuted },
                      ]}
                    >
                      <View style={styles.rowLeft}>
                        <Text style={[styles.rowName, textDir(isRTL)]} numberOfLines={1}>
                          {p.name}
                        </Text>
                        <Text style={[styles.rowSub, textDir(isRTL)]} numberOfLines={1}>
                          {p.phone ?? t("contacts.noPhone")}
                        </Text>
                      </View>
                      <RightAmount balance={p.balance} hasEntries={p.last_entry_at !== null} />
                    </Pressable>
                    {i < visibleResults.length - 1 ? <View style={styles.divider} /> : null}
                  </View>
                ))}
              </View>
              {hiddenResultCount > 0 ? (
                <Text style={[styles.noMatchText, { marginTop: 8 }, textDir(isRTL)]}>
                  {t("personAdd.moreResults", { count: hiddenResultCount })}
                </Text>
              ) : null}
            </View>
          ) : null}

          {showNoMatchesText ? (
            <View style={styles.noMatchSection}>
              <Text style={styles.noMatchText}>{t("personAdd.noMatch", { query: trimmed })}</Text>
            </View>
          ) : null}

          {isCreating ? (
            <>
              <View style={styles.field}>
                <Text style={[styles.label, textDir(isRTL)]}>{t("personEdit.phone.label")}</Text>
                {/* Phone row deliberately stays physical-LTR even in
                    Persian: Western digits render left-to-right via Unicode
                    bidi regardless of the container, and Persian users
                    enter phone numbers digit-by-digit from the left. The
                    label and hint above/below flip via textDir to follow
                    reading order; only the input field itself + country
                    button stay anchored LTR. */}
                <View style={styles.phoneRow}>
                  <Pressable
                    onPress={() => setPickerVisible(true)}
                    style={({ pressed }) => [
                      styles.countryBtn,
                      pressed && { backgroundColor: colors.bgMuted },
                    ]}
                  >
                    <Text style={styles.countryFlag}>{country.flag}</Text>
                    <Text style={styles.countryDial}>{country.dialCode}</Text>
                    <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
                  </Pressable>
                  <TextInput
                    ref={phoneRef}
                    style={[styles.phoneInput, phoneError ? styles.inputError : null]}
                    value={phone}
                    onChangeText={(v) => {
                      setPhoneError(null);
                      setPhone(v);
                    }}
                    placeholder={
                      country.code === "AF"
                        ? "70 123 4567"
                        : t("personAdd.phone.placeholderGeneric")
                    }
                    placeholderTextColor={colors.textMuted}
                    accessibilityLabel={t("personEdit.phone.label")}
                    keyboardType="phone-pad"
                    returnKeyType="done"
                    onSubmitEditing={createAndOpen}
                  />
                </View>
                {phoneError ? (
                  <Text
                    style={[styles.fieldError, textDir(isRTL)]}
                    accessibilityLiveRegion="polite"
                  >
                    {phoneError}
                  </Text>
                ) : null}
                <Text style={[styles.fieldHint, textDir(isRTL)]}>{t("personAdd.phone.hint")}</Text>
              </View>

              {saveError ? (
                <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
                  {saveError}
                </Text>
              ) : null}
              <View style={{ height: 8 }} />
              <Button
                label={t("personAdd.add", { name: trimmed })}
                onPress={createAndOpen}
                loading={busy}
              />
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      <CountryPickerSheet
        visible={pickerVisible}
        selectedCode={countryCode}
        onSelect={(c) => setCountryCode(c)}
        onDismiss={() => setPickerVisible(false)}
      />

      <ContactsPickerSheet
        visible={contactsVisible}
        onPick={onContactPicked}
        onDismiss={() => setContactsVisible(false)}
      />
    </SafeAreaView>
  );
}

// Right-aligned amount cell — uses + / − prefix to convey direction without
// breaking the monochrome palette.
function RightAmount(props: { balance: number; hasEntries: boolean }) {
  if (!props.hasEntries) {
    return <Text style={styles.rightMuted}>{t("personAdd.rightAmount.new")}</Text>;
  }
  if (props.balance === 0) {
    return <Text style={styles.rightMuted}>{t("personAdd.rightAmount.settled")}</Text>;
  }
  const sign = props.balance > 0 ? "+" : "−";
  return (
    <View style={styles.rightAmountRow}>
      <Text style={styles.rightSign}>{sign}</Text>
      <Text style={styles.rightAmount}>{formatAmount(props.balance)}</Text>
      <Text style={styles.rightAfn}>{getCurrentCurrencySymbol()}</Text>
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
  // Compound phone input: country picker button on the left + national-number
  // text input on the right, joined into one visual unit.
  phoneRow: { flexDirection: "row", gap: 8 },
  countryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 8,
    backgroundColor: colors.bgDefault,
  },
  countryFlag: { fontSize: 18 },
  countryDial: {
    fontSize: 14,
    fontFamily: fonts.monoMedium,
    color: colors.textEmphasis,
  },
  phoneInput: {
    flex: 1,
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
  pickFromContacts: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    paddingVertical: 4,
    // alignSelf is set inline based on isRTL — see usage site.
  },
  pickFromContactsText: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
  },

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

  // Mirrors FormField's error treatment — see entry/new.tsx.
  inputError: {
    borderColor: colors.danger,
    backgroundColor: "rgba(220, 38, 38, 0.04)",
  },
  fieldError: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 6,
    marginBottom: 6,
  },
});
