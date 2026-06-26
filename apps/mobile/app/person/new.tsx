import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
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
import { CountryPickerSheet } from "../../components/CountryPickerSheet";
import { useToast } from "../../components/Toast";
import { colors } from "../../lib/colors";
import {
  joinName,
  phoneKey,
  readDeviceContacts,
  type DeviceContact,
} from "../../lib/contacts-sync";
import { getCurrentCurrencySymbol } from "../../lib/currency";
import { createPerson, getActiveVaultArchivedState, listAllPeopleForSearch } from "../../lib/db";
import { toAsciiDigits } from "../../lib/digits";
import { rowDir, textDir, useIsRTL } from "../../lib/direction";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../../lib/event-log";
import { fonts } from "../../lib/fonts";
import { formatAmount } from "../../lib/format";
import { t } from "../../lib/i18n";
import { getCountry, getCurrentDefaultCountryCode, inferCountryFromE164 } from "../../lib/phone";
import { searchContacts } from "../../lib/search";
import type { PersonWithBalance } from "../../lib/types";

// At least this many digits before the phone field narrows the list — typing
// "7" or "70" otherwise matches half the book.
const PHONE_SEARCH_MIN_DIGITS = 3;

// Max device contacts rendered in the "All contacts" card at once. The list is
// a plain card (not virtualized), so a huge phone book would jank; typing
// filters well under this. A truncation hint shows when the book is larger.
const DEVICE_LIST_CAP = 80;

// One row in the merged contacts list. App people open on tap; device contacts
// are created (and added to the ledger) on tap.
type Row = { kind: "app"; person: PersonWithBalance } | { kind: "device"; contact: DeviceContact };

type Section = { key: string; title: string; data: Row[] };

// Add-or-find screen. The form (first name + last name + number + Add button)
// lives fixed at the top; below it is one virtualized list that merges the
// people already in this kaata with the device's whole phone book — typing in
// EITHER the name fields or the number field filters both (Matee: "list all
// contacts below the recents", "the phone field should act like the name field
// too"). The app's contacts are kept "one with" the phone book: creating a
// person here also writes them to the device Contacts app (see contacts-sync).
export default function PersonAddOrFindScreen() {
  const router = useRouter();
  const toast = useToast();
  // Subscribes to locale changes — flipping language in Settings live-updates
  // this screen if it happens to be focused.
  const isRTL = useIsRTL();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  // Initial country defaults to the user's preference (set in Preferences).
  const [countryCode, setCountryCode] = useState(getCurrentDefaultCountryCode);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [people, setPeople] = useState<PersonWithBalance[] | null>(null);
  // Device phone book + its permission state (null = still loading).
  const [deviceContacts, setDeviceContacts] = useState<DeviceContact[]>([]);
  const [contactsGranted, setContactsGranted] = useState<boolean | null>(null);
  const [contactsCanAsk, setContactsCanAsk] = useState(true);
  const [busy, setBusy] = useState(false);
  // Inline errors — modal screen, toasts can't render above it (Toast.tsx).
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const firstNameRef = useRef<TextInput>(null);
  const lastNameRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  // Synchronous re-entry guard — `busy` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx.
  const savingRef = useRef(false);
  const country = getCountry(countryCode);

  // D-DEFENSIVE-ARCHIVED-GUARD: see entry/new.tsx. A mesh-sourced archive can
  // land between home's load() and this screen's mount; bail before any write.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the device phone book once, best-effort + non-blocking.
  useEffect(() => {
    let cancelled = false;
    void readDeviceContacts().then((res) => {
      if (cancelled) return;
      setDeviceContacts(res.contacts);
      setContactsGranted(res.granted);
      setContactsCanAsk(res.canAskAgain);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Focus the first-name field via ref + delay, NOT autoFocus: on a stack-modal
  // screen autoFocus fires before the slide-in finishes, so focus succeeds but
  // the soft keyboard never opens on Android. 280ms clears the animation.
  useEffect(() => {
    const tmr = setTimeout(() => firstNameRef.current?.focus(), 280);
    return () => clearTimeout(tmr);
  }, []);

  // Retry contacts access when the permission affordance is tapped: re-ask if we
  // still can, otherwise send the user to system settings.
  async function onRequestContacts() {
    if (contactsGranted === false && !contactsCanAsk) {
      void Linking.openSettings();
      return;
    }
    const res = await readDeviceContacts();
    setDeviceContacts(res.contacts);
    setContactsGranted(res.granted);
    setContactsCanAsk(res.canAskAgain);
    if (!res.granted && !res.canAskAgain) void Linking.openSettings();
  }

  const nameQuery = joinName(firstName, lastName);
  const phoneDigits = toAsciiDigits(phone).replace(/\D/g, "");
  const phoneFilter = phoneDigits.length >= PHONE_SEARCH_MIN_DIGITS ? phoneDigits : "";
  const querying = nameQuery.length > 0 || phoneFilter.length > 0;

  // Defer the values the (potentially large) phone-book filter runs on, so each
  // keystroke stays responsive while the list catches up (React concurrent).
  // First + last are deferred SEPARATELY so the search can rank by field (a
  // last-name query ranks last-name matches above first-name ones).
  const dFirst = useDeferredValue(firstName.trim());
  const dLast = useDeferredValue(lastName.trim());
  const dPhone = useDeferredValue(phoneFilter);
  const dQuerying = dFirst.length > 0 || dLast.length > 0 || dPhone.length > 0;

  // Phone keys of people already in this kaata, to dedup the device book against
  // the ledger (never offer to add someone you already have).
  const appPhoneKeys = useMemo(() => {
    const s = new Set<string>();
    for (const p of people ?? []) {
      const k = phoneKey(p.phone);
      if (k) s.add(k);
    }
    return s;
  }, [people]);

  const dedupedDevice = useMemo(
    () =>
      deviceContacts.filter((c) => {
        const k = phoneKey(c.phone);
        return !k || !appPhoneKeys.has(k);
      }),
    [deviceContacts, appPhoneKeys],
  );

  // Each section renders as ONE bordered card (no virtualization), so cap the
  // device list when not searching — a full phone book (hundreds/thousands of
  // rows) mounted at once would jank. Typing narrows it well under the cap.
  const { sections, deviceTruncated } = useMemo<{
    sections: Section[];
    deviceTruncated: boolean;
  }>(() => {
    const out: Section[] = [];
    const appList = people ?? [];
    const appMatches = dQuerying ? searchContacts(dFirst, dLast, dPhone, appList) : appList;
    if (appMatches.length > 0) {
      out.push({
        key: "app",
        title: dQuerying ? t("personAdd.section.matches") : t("personAdd.section.recent"),
        data: appMatches.map((person) => ({ kind: "app", person })),
      });
    }
    const deviceFull = dQuerying
      ? searchContacts(dFirst, dLast, dPhone, dedupedDevice)
      : dedupedDevice;
    const deviceShown = deviceFull.slice(0, DEVICE_LIST_CAP);
    if (deviceShown.length > 0) {
      out.push({
        key: "device",
        title: dQuerying ? t("personAdd.section.fromPhone") : t("personAdd.section.allContacts"),
        data: deviceShown.map((contact) => ({ kind: "device", contact })),
      });
    }
    return { sections: out, deviceTruncated: deviceFull.length > deviceShown.length };
  }, [people, dedupedDevice, dQuerying, dFirst, dLast, dPhone]);

  function openPerson(id: string) {
    router.replace({ pathname: "/person/[id]", params: { id } });
  }

  // Shared create path for both the form's Add button and a tapped device
  // contact. Best-effort phone-book write happens inside createPerson.
  async function runCreate(first: string, last: string | null, phoneInput: string, cc: string) {
    if (savingRef.current || people === null) return;
    const fn = first.trim();
    if (!fn) return; // first name is required to create
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
      const result = await createPerson(fn, last?.trim() || null, phoneInput.trim() || null, cc);
      if (!result.ok) {
        if (result.error === "phone_invalid") {
          setPhoneError(t("personAdd.phone.invalid"));
        } else if (result.error === "phone_is_self") {
          setPhoneError(t("personAdd.phone.isSelf"));
        } else if (result.error === "phone_conflict") {
          setPhoneError(t("personAdd.phone.conflict", { name: result.existing.name }));
        }
        return;
      }
      openPerson(result.id);
    } catch (err) {
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

  function onAddPressed() {
    void runCreate(firstName, lastName, phone, countryCode);
  }

  // Tapping a phone contact creates it directly (its name + number) and opens
  // the new person — the fastest path from "browse my phone" to "in the ledger".
  // The form above stays for people who AREN'T in the phone book yet.
  function onDeviceContactTap(c: DeviceContact) {
    let cc = countryCode;
    let national = "";
    if (c.phone) {
      const raw = toAsciiDigits(c.phone.trim());
      if (raw.startsWith("+")) {
        cc = inferCountryFromE164(raw);
        const dial = getCountry(cc).dialCode;
        national = raw.startsWith(dial) ? raw.slice(dial.length).trim() : raw;
      } else {
        // National-format: drop a leading trunk 0; createPerson re-prefixes the
        // dial code for the selected country.
        const cleaned = raw.replace(/[^\d]/g, "");
        national = cleaned.startsWith("0") ? cleaned.slice(1) : cleaned;
      }
    }
    void runCreate(c.firstName, c.lastName, national, cc);
  }

  const addLabel =
    nameQuery.length > 0 ? t("personAdd.add", { name: nameQuery }) : t("personAdd.title");
  const canAdd = firstName.trim().length > 0;

  function renderItem({ item }: { item: Row }) {
    if (item.kind === "app") {
      const p = item.person;
      return (
        <Pressable
          onPress={() => openPerson(p.id)}
          style={({ pressed }) => [styles.row, rowDir(isRTL), pressed && styles.rowPressed]}
        >
          <View style={[styles.rowLeft, isRTL && styles.rowLeftRTL]}>
            <Text style={[styles.rowName, textDir(isRTL)]} numberOfLines={1}>
              {p.name}
            </Text>
            <Text style={[styles.rowSub, textDir(isRTL)]} numberOfLines={1}>
              {p.phone ?? t("contacts.noPhone")}
            </Text>
          </View>
          <RightAmount balance={p.balance} hasEntries={p.last_entry_at !== null} />
        </Pressable>
      );
    }
    const c = item.contact;
    return (
      <Pressable
        onPress={() => onDeviceContactTap(c)}
        accessibilityRole="button"
        disabled={busy}
        style={({ pressed }) => [styles.row, rowDir(isRTL), pressed && styles.rowPressed]}
      >
        <View style={styles.rowLeft}>
          <Text style={[styles.rowName, textDir(isRTL)]} numberOfLines={1}>
            {c.name}
          </Text>
          <Text style={[styles.rowSub, textDir(isRTL)]} numberOfLines={1}>
            {c.phone ?? t("contacts.noPhone")}
          </Text>
        </View>
        <Ionicons name="add-circle-outline" size={22} color={colors.textMuted} />
      </Pressable>
    );
  }

  function renderEmpty() {
    if (people === null) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.textDefault} />
        </View>
      );
    }
    if (querying) {
      return (
        <View style={styles.noMatchSection}>
          <Text style={[styles.noMatchText, textDir(isRTL)]}>
            {t("personAdd.noMatch", { query: nameQuery || phone })}
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.emptyHint}>
        <Text style={styles.emptyTitle}>{t("personAdd.empty.title")}</Text>
        <Text style={styles.emptySub}>{t("personAdd.empty.subtitle")}</Text>
      </View>
    );
  }

  // Footer affordance to grant contacts access when the book is unavailable, so
  // the device-contacts section isn't just silently missing.
  function renderFooter() {
    if (contactsGranted !== false) return null;
    return (
      <Pressable
        onPress={onRequestContacts}
        style={({ pressed }) => [styles.permRow, rowDir(isRTL), pressed && styles.rowPressed]}
      >
        <Ionicons name="people-outline" size={18} color={colors.textSubtle} />
        <Text style={[styles.permText, textDir(isRTL)]}>
          {contactsCanAsk ? t("personAdd.contacts.allow") : t("personAdd.contacts.openSettings")}
        </Text>
      </Pressable>
    );
  }

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
        {/* Fixed form — name (first + last), number, Add. Kept OUT of the list
            so the inputs never remount on a list re-render (Android focus loss). */}
        <View style={styles.form}>
          {/* In Dari the two name fields mirror: first name sits at the start
              (right) edge, last name to its left. rowDir flips the pair; each
              input's own textDir right-aligns what's typed. */}
          <View style={[styles.nameRow, rowDir(isRTL)]}>
            <TextInput
              ref={firstNameRef}
              style={[styles.nameInput, textDir(isRTL)]}
              value={firstName}
              onChangeText={setFirstName}
              placeholder={t("personAdd.firstName.placeholder")}
              placeholderTextColor={colors.textMuted}
              accessibilityLabel={t("personEdit.firstName.label")}
              autoCorrect={false}
              autoCapitalize="words"
              maxLength={40}
              returnKeyType="next"
              onSubmitEditing={() => lastNameRef.current?.focus()}
              submitBehavior="submit"
            />
            <TextInput
              ref={lastNameRef}
              style={[styles.nameInput, textDir(isRTL)]}
              value={lastName}
              onChangeText={setLastName}
              placeholder={t("personAdd.lastName.placeholder")}
              placeholderTextColor={colors.textMuted}
              accessibilityLabel={t("personEdit.lastName.label")}
              autoCorrect={false}
              autoCapitalize="words"
              maxLength={40}
              returnKeyType="next"
              onSubmitEditing={() => phoneRef.current?.focus()}
              submitBehavior="submit"
            />
          </View>

          {/* Phone row stays physical-LTR even in Persian: Western digits render
              LTR via Unicode bidi and are entered left-to-right. */}
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
                country.code === "AF" ? "70 123 4567" : t("personAdd.phone.placeholderGeneric")
              }
              placeholderTextColor={colors.textMuted}
              accessibilityLabel={t("personEdit.phone.label")}
              keyboardType="phone-pad"
              returnKeyType="done"
              onSubmitEditing={onAddPressed}
            />
          </View>

          {phoneError ? (
            <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {phoneError}
            </Text>
          ) : null}
          {saveError ? (
            <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {saveError}
            </Text>
          ) : null}

          <View style={{ height: 10 }} />
          <Button label={addLabel} onPress={onAddPressed} loading={busy} disabled={!canAdd} />
        </View>

        {/* Each section is its OWN bordered card (Recent / All contacts), like
            the home people list (Matee). A single card container per section
            avoids the Android per-row asymmetric-border bug. */}
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.listContent}
        >
          {people === null || sections.length === 0
            ? renderEmpty()
            : sections.map((section) => (
                <View key={section.key} style={styles.section}>
                  <Text style={[styles.sectionLabel, textDir(isRTL)]}>{section.title}</Text>
                  <View style={styles.peopleCard}>
                    {section.data.map((item, index) => (
                      <View
                        key={
                          item.kind === "app" ? `app-${item.person.id}` : `dev-${item.contact.id}`
                        }
                      >
                        {index > 0 ? <View style={styles.divider} /> : null}
                        {renderItem({ item })}
                      </View>
                    ))}
                  </View>
                  {section.key === "device" && deviceTruncated ? (
                    <Text style={[styles.moreHint, textDir(isRTL)]}>
                      {t("personAdd.moreContacts")}
                    </Text>
                  ) : null}
                </View>
              ))}
          {renderFooter()}
        </ScrollView>
      </KeyboardAvoidingView>

      <CountryPickerSheet
        visible={pickerVisible}
        selectedCode={countryCode}
        onSelect={(c) => setCountryCode(c)}
        onDismiss={() => setPickerVisible(false)}
      />
    </SafeAreaView>
  );
}

// Right-aligned amount cell — + / − prefix conveys direction in a monochrome UI.
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

  // Fixed top form.
  form: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderDefault,
  },
  nameRow: { flexDirection: "row", gap: 10, marginBottom: 10 },
  nameInput: {
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
  countryDial: { fontSize: 14, fontFamily: fonts.monoMedium, color: colors.textEmphasis },
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
  inputError: { borderColor: colors.danger, backgroundColor: "rgba(220, 38, 38, 0.04)" },
  fieldError: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 8,
  },

  // Merged contacts list — each section is its own bordered card.
  listContent: { paddingBottom: 32, flexGrow: 1 },
  section: { marginBottom: 4 },
  sectionLabel: {
    fontSize: 11,
    fontFamily: fonts.sansSemi,
    color: colors.textSubtle,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 6,
  },
  peopleCard: {
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.bgDefault,
  },
  divider: { height: 1, backgroundColor: colors.borderDefault },
  moreHint: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.bgDefault,
  },
  rowPressed: { backgroundColor: colors.bgMuted },
  rowLeft: { flex: 1, marginRight: 12 },
  // RTL: the row is row-reversed, so the name block sits on the right and the
  // amount/add icon on the left — the gap belongs on the left edge instead.
  rowLeftRTL: { marginRight: 0, marginLeft: 12 },
  rowName: { fontSize: 15, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  rowSub: { fontSize: 12, fontFamily: fonts.sansRegular, color: colors.textSubtle, marginTop: 2 },

  rightAmountRow: { flexDirection: "row", alignItems: "baseline", gap: 2 },
  rightSign: {
    fontSize: 14,
    fontFamily: fonts.monoMedium,
    color: colors.textDefault,
    marginRight: 2,
  },
  rightAmount: { fontSize: 14, fontFamily: fonts.monoSemi, color: colors.textEmphasis },
  rightAfn: { fontSize: 11, fontFamily: fonts.sansMedium, color: colors.textMuted, marginLeft: 2 },
  rightMuted: { fontSize: 12, fontFamily: fonts.sansMedium, color: colors.textMuted },

  centered: { alignItems: "center", paddingVertical: 24 },
  emptyHint: { paddingTop: 24, paddingHorizontal: 16, alignItems: "center" },
  emptyTitle: { fontSize: 14, fontFamily: fonts.sansSemi, color: colors.textEmphasis },
  emptySub: {
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    marginTop: 4,
    textAlign: "center",
  },
  noMatchSection: { paddingVertical: 16, paddingHorizontal: 16 },
  noMatchText: { fontSize: 13, fontFamily: fonts.sansRegular, color: colors.textSubtle },

  permRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  permText: { flex: 1, fontSize: 13, fontFamily: fonts.sansMedium, color: colors.textSubtle },
});
