// Account — the user's PERSONAL settings (one place, per Matee). Edits the
// device identity (first/last name + phone) and folds in the personal
// preferences (language + default country). Distinct from "Manage this Kaata"
// (per-kaata: name, currency, members). Archived kaatas live in the kaata
// switcher, not here (Matee).
//
// Name + phone are saved via updateSelfProfile (name is event-sourced when a
// kaata is active so shared members see it; phone is device-local identity).
// Language + default country auto-commit (no Save) like the old Preferences.

import { Ionicons } from "@expo/vector-icons";
import { Stack, useFocusEffect, useNavigation, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  accountFailureText,
  accountNameProblem,
  accountRefusal,
  normalizeAccountName,
} from "../lib/account-rules";
import {
  type AccountMe,
  applyForCurrentSession,
  accountNameState,
  captureCurrentSession,
  currentSessionKind,
  deleteAccount,
  fetchAccountMe,
  getSessionJWT,
  hasPendingAccountDeletion,
  removePassword,
  resetRetiredInstall,
  saveAccountDisplayName,
  SessionChangedError,
  updateAccountPhone,
} from "../lib/auth";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CountryPickerSheet } from "../components/CountryPickerSheet";
import { OptionSheet } from "../components/OptionSheet";
import { ScreenLoading } from "../components/ScreenLoading";
import { NavRow, ScreenHeader, SectionGap, SectionHeader } from "../components/SettingsScreen";
import { useToast } from "../components/Toast";
import { colors } from "../lib/colors";
import { joinName, splitName } from "../lib/contacts-sync";
import { getAppMeta, getLocalSelf, setAppMeta, updateSelfProfile } from "../lib/db";
import { ltrIsolate, rowDir, textDir, useIsRTL } from "../lib/direction";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../lib/event-log";
import { fonts } from "../lib/fonts";
import {
  getLocale,
  getShareLangPref,
  setLocale,
  t,
  type LocalePref,
  type ShareLangPref,
} from "../lib/i18n";
import {
  CALENDAR_PREF_KEY,
  getQamariOffset,
  parseCalendarPref,
  QAMARI_OFFSET_KEY,
  setCalendarPref,
  setQamariOffset,
  type Calendar,
  type CalendarPref,
} from "../lib/calendar";
import { getInstallRetiredRecoverableUntil, isInstallRetired } from "../lib/install-id";
import { formatDate } from "../lib/format";
import { formatCalendarDate } from "../lib/jalali";
import {
  getCountry,
  getCurrentDefaultCountryCode,
  inferCountryFromE164,
  normalizePhone,
  setCurrentDefaultCountryCode,
} from "../lib/phone";
import { gutter, icon, radius, ROW_MIN, TOUCH_MIN, typography } from "../lib/tokens";

const LANGUAGE_OPTIONS: ReadonlyArray<{ value: LocalePref; labelKey: string }> = [
  { value: "system", labelKey: "settings.language.option.system" },
  { value: "en", labelKey: "settings.language.option.en" },
  { value: "fa", labelKey: "settings.language.option.fa" },
];

// Message language — the language of outgoing WhatsApp messages (ledger ping,
// invite link) and the shared ledger web page, independent of the app UI
// language. Dari before English: it's the common explicit pick.
const MESSAGE_LANGUAGE_OPTIONS: ReadonlyArray<{ value: ShareLangPref; labelKey: string }> = [
  { value: "auto", labelKey: "settings.messageLang.option.auto" },
  { value: "ask", labelKey: "settings.messageLang.option.ask" },
  { value: "fa", labelKey: "settings.language.option.fa" },
  { value: "en", labelKey: "settings.language.option.en" },
];

// Calendar system. 'auto' first because it is the default and reproduces the
// pre-setting behaviour (Solar Hijri when the app language is Dari); the three
// explicit picks follow in the order a shopkeeper is likeliest to want them.
// Independent of language on purpose — Dari + Gregorian is a real combination
// that could not be expressed before. See lib/calendar.ts.
// The Qamari adjustment, in words: "+1"/"−1" beside Persian digits reorders
// under the bidi algorithm, and "later/earlier" says which way the date moves.
const QAMARI_OFFSET_OPTIONS: ReadonlyArray<{ value: number; labelKey: string }> = [
  { value: -2, labelKey: "settings.qamariOffset.earlier2" },
  { value: -1, labelKey: "settings.qamariOffset.earlier1" },
  { value: 0, labelKey: "settings.qamariOffset.none" },
  { value: 1, labelKey: "settings.qamariOffset.later1" },
  { value: 2, labelKey: "settings.qamariOffset.later2" },
];

const CALENDAR_OPTIONS: ReadonlyArray<{ value: CalendarPref; labelKey: string }> = [
  { value: "auto", labelKey: "settings.calendar.option.auto" },
  { value: "gregorian", labelKey: "settings.calendar.option.gregorian" },
  { value: "jalali", labelKey: "settings.calendar.option.jalali" },
  { value: "qamari", labelKey: "settings.calendar.option.qamari" },
];

// Public privacy policy — the same page linked from the web footer. Both stores
// require it to be reachable from inside the app.
const PRIVACY_URL = "https://kaata.af/privacy";

export default function AccountScreen() {
  const router = useRouter();
  const toast = useToast();
  const isRTL = useIsRTL();
  const insets = useSafeAreaInsets();

  const [loaded, setLoaded] = useState(false);
  // Profile (editable).
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCountry, setPhoneCountry] = useState(getCurrentDefaultCountryCode);
  const [phonePickerVisible, setPhonePickerVisible] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const lastNameRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);

  // Preferences (auto-commit).
  const [localePref, setLocalePref] = useState<LocalePref>("system");
  const [langSheetVisible, setLangSheetVisible] = useState(false);
  const [shareLangPref, setShareLangPref] = useState<ShareLangPref>("auto");
  const [msgLangSheetVisible, setMsgLangSheetVisible] = useState(false);
  const [calendarPref, setCalendarPrefState] = useState<CalendarPref>("auto");
  const [calSheetVisible, setCalSheetVisible] = useState(false);
  const [qamariOffset, setQamariOffsetState] = useState(getQamariOffset);
  const [qamariSheetVisible, setQamariSheetVisible] = useState(false);
  const [prefCountry, setPrefCountry] = useState(getCurrentDefaultCountryCode);
  const [prefCountryVisible, setPrefCountryVisible] = useState(false);

  // Account deletion (only offered when signed in — a local-only user has no
  // server account to delete; they reset via the app uninstall).
  const [signedIn, setSignedIn] = useState(false);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletionRecoveryNeeded, setDeletionRecoveryNeeded] = useState(false);
  // Guards BOTH erasing flows (deletion and the retired-install reset), so one
  // can never start while the other is still running.
  const deletingRef = useRef(false);
  const navigation = useNavigation();
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (deletingRef.current) event.preventDefault();
      }),
    [navigation],
  );
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => deletingRef.current,
      );
      return () => subscription.remove();
    }, []),
  );
  // Retired installation (InstallRetiredError in lib/auth.ts): an account this
  // phone was signed in to was deleted, so the server refuses it. Shown signed
  // in or not, from the flag check-in and sign-in set on a 410 (and clear
  // again on a later success for the same install id).
  const [retired, setRetired] = useState(false);
  // While the deleted account is inside its 30-day grace window, signing in
  // with it cancels the deletion: offer that first, the erasing reset second.
  const [retiredUntil, setRetiredUntil] = useState<number | null>(null);
  const [resetConfirmVisible, setResetConfirmVisible] = useState(false);
  // Sign-in section (docs/kaata-accounts.md §7): how this account signs in, read
  // from the server on every visit, since the password and username screens
  // change it. Shown only with a live session.
  const [hasSession, setHasSession] = useState(false);
  // How this session signed in: Google/Apple ("provider") or a Kaata password
  // ("email"). Only "provider" may remove the password.
  const [sessionKind, setSessionKind] = useState<"provider" | "email" | null>(null);
  const [me, setMe] = useState<AccountMe | null>(null);
  const [meFailed, setMeFailed] = useState(false);
  const [removeConfirmVisible, setRemoveConfirmVisible] = useState(false);
  const removingRef = useRef(false);
  // The name as it was when the screen opened (a save sends the account's name
  // only when it changed), and whether the account still owes one or holds an
  // invalid one (then it is sent even unchanged, to settle it).
  const initialNameRef = useRef("");
  const nameUnsettledRef = useRef(false);
  const nameEditedRef = useRef(false);

  const loadMe = useCallback(async () => {
    setMeFailed(false);
    try {
      const session = await captureCurrentSession();
      if (!session.jwt || !session.accountId) return;
      const account = await fetchAccountMe(session);
      await applyForCurrentSession(session, async () => {
        setMe(account);
        // Another phone may have renamed the account. Prefill its current name
        // without replacing an in-progress edit or this phone's queued save,
        // and only a name chosen in Kaata: a Google/Apple profile name used
        // to replace the phone's own name, and a phone-only save then wrote it
        // over the name the user picked.
        if (
          account.name &&
          account.nameExplicit &&
          !nameEditedRef.current &&
          !nameUnsettledRef.current
        ) {
          initialNameRef.current = account.name;
          const split = splitName(account.name);
          setFirstName(split.firstName);
          setLastName(split.lastName ?? "");
        }
      });
    } catch (err) {
      if (err instanceof SessionChangedError) return;
      console.warn("[account] fetchAccountMe failed", err);
      setMeFailed(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (hasSession) void loadMe();
    }, [hasSession, loadMe]),
  );

  useEffect(() => {
    void (async () => {
      const self = await getLocalSelf();
      if (self) {
        initialNameRef.current = self.name;
        const s = splitName(self.name);
        setFirstName(s.firstName);
        setLastName(s.lastName ?? "");
        if (self.phone) {
          const inferred = inferCountryFromE164(self.phone);
          const dial = getCountry(inferred).dialCode;
          setPhoneCountry(inferred);
          setPhone(self.phone.startsWith(dial) ? self.phone.slice(dial.length) : self.phone);
        }
      }
      const storedPref = await getAppMeta("locale_pref");
      setLocalePref(storedPref === "en" || storedPref === "fa" ? storedPref : "system");
      setShareLangPref(await getShareLangPref());
      // parseCalendarPref, not a raw cast — the row is untrusted (an older
      // build, a restore, a manual edit) and an unknown value must land on
      // 'auto' rather than poisoning every date on the screen.
      setCalendarPrefState(parseCalendarPref(await getAppMeta(CALENDAR_PREF_KEY)));
      setPrefCountry(getCurrentDefaultCountryCode());
      const session = !!(await getSessionJWT());
      setSessionKind(await currentSessionKind().catch(() => null));
      // An automatic send found the phone's name unusable for the account
      // (lib/auth syncPendingAccountNameFromSelf): ask for a better one here.
      const nameState = session ? await accountNameState() : "settled";
      nameUnsettledRef.current = nameState !== "settled";
      if (nameState === "invalid") setNameError(t("auth.error.name.invalid"));
      setHasSession(session);
      setSignedIn(session || (await hasPendingAccountDeletion()));
      setDeletionRecoveryNeeded((await getAppMeta("account_deletion_cleanup_blocked")) === "1");
      setRetired(await isInstallRetired().catch(() => false));
      setRetiredUntil(await getInstallRetiredRecoverableUntil().catch(() => null));
      setLoaded(true);
    })();
  }, []);

  // Delete the server account + wipe all local data, then rebuild a clean
  // schema and drop the user back into onboarding (mirrors a fresh install).
  // The server delete must succeed first; on failure we keep everything and
  // toast so the user can retry, rather than wiping their only ledger copy.
  async function onConfirmDelete() {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setDeleteConfirmVisible(false);
    try {
      await deleteAccount();
      // The confirmed cleanup also rebuilt a fresh local schema.
      deletingRef.current = false;
      router.replace("/onboarding");
    } catch (err) {
      console.warn("[account] deleteAccount failed", err);
      if (err instanceof Error && err.message === "account_delete_late_edits") {
        setDeletionRecoveryNeeded(true);
      }
      toast.push(
        t(
          err instanceof Error && err.message === "account_delete_auth_required"
            ? "account.deleteAccount.authRequired"
            : err instanceof Error && err.message === "account_delete_grace_unavailable"
              ? "account.deleteAccount.graceUnavailable"
              : err instanceof Error && err.message === "account_delete_late_edits"
                ? "account.deleteAccount.lateEdits"
                : "account.deleteAccount.backupFailed",
        ),
        "error",
      );
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  // Retired installation: erase this phone and start over under a fresh
  // install id. Local only (the server already refuses this install), reached
  // only through the destructive confirmation, and landing exactly where a
  // completed deletion lands.
  async function onConfirmReset() {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setResetConfirmVisible(false);
    try {
      await resetRetiredInstall();
      router.replace("/onboarding");
    } catch (err) {
      console.warn("[account] resetRetiredInstall failed", err);
      toast.push(t("account.retired.failed"), "error");
    } finally {
      deletingRef.current = false;
    }
  }

  // Remove password: only a Google or Apple session may (§6.12), and the row
  // only shows for one. A password someone else added is removed this way.
  async function onConfirmRemovePassword() {
    if (removingRef.current) return;
    removingRef.current = true;
    setRemoveConfirmVisible(false);
    try {
      await removePassword(getLocale());
      toast.push(t("accountPassword.remove.done"), "success");
    } catch (err) {
      console.warn("[account] removePassword failed", err);
      toast.push(accountFailureText(err), "error");
    } finally {
      removingRef.current = false;
      void loadMe();
    }
  }

  async function onSave() {
    if (savingRef.current) return;
    // Every signed-in account can choose its Kaata display name. The server
    // stores it separately from Google/Apple identity and applies the same
    // whitespace and 2–60 character rule for every sign-in provider.
    const ours = hasSession;
    const fn = ours ? normalizeAccountName(firstName) : firstName.trim();
    const ln = ours ? normalizeAccountName(lastName) : lastName.trim();
    if (!fn) {
      setNameError(t("onboarding.nameRequired"));
      return;
    }
    const fullName = joinName(fn, ln || null);
    const nameChanged =
      normalizeAccountName(fullName) !== normalizeAccountName(initialNameRef.current);
    // Imported provider names may predate this validation rule. A phone-only
    // save keeps one usable; an explicit rename follows the current rule.
    if (ours && (nameChanged || nameUnsettledRef.current) && accountNameProblem(fullName)) {
      setNameError(t("auth.error.name.invalid"));
      return;
    }
    setNameError(null);
    let normalizedPhone: string | null = null;
    const trimmedPhone = phone.trim();
    if (trimmedPhone) {
      normalizedPhone = normalizePhone(trimmedPhone, phoneCountry);
      if (!normalizedPhone) {
        setPhoneError(t("personAdd.phone.invalid"));
        return;
      }
    }
    setPhoneError(null);
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      // Capture the intended account before any async local write. A switch
      // during the save cannot carry this name/phone into the next account.
      const session = hasSession ? await captureCurrentSession() : null;
      if (session) {
        await applyForCurrentSession(session, () =>
          updateSelfProfile(fullName, null, normalizedPhone),
        );
      } else {
        await updateSelfProfile(fullName, null, normalizedPhone);
      }
      // BUG-1: mirror the phone to the account server-side so it survives a
      // reinstall (the local users.phone_e164 is device-local). Best-effort.
      void updateAccountPhone(normalizedPhone, session ?? undefined);
      if (ours && (nameChanged || nameUnsettledRef.current)) {
        // Only a name that changed (or one the account still owes): sent now,
        // and a refusal shown instead of "Saved" (the phone keeps the name
        // either way). An unreachable server queues this exact name for the
        // same account's check-in; an unsupported endpoint remains an error.
        const refusal = await saveAccountDisplayName(fullName, session ?? undefined);
        if (refusal) {
          const shown = accountRefusal(refusal);
          if (shown?.field === "name") setNameError(shown.text);
          else setSaveError(shown?.text ?? accountFailureText(refusal));
          return;
        }
      }
      // Local saves and failed/offline network replies can also span a
      // sign-in switch. Check again before claiming success or navigating.
      const finishSave = async () => {
        nameUnsettledRef.current = false;
        initialNameRef.current = fullName;
        toast.push(t("settings.saved"), "success");
        router.back();
      };
      if (session) await applyForCurrentSession(session, finishSave);
      else await finishSave();
    } catch (err) {
      console.warn("[account] updateSelfProfile failed", err);
      if (err instanceof EventSigningUnavailableError) {
        setSaveError(t("entry.signingUnavailable"));
      } else if (err instanceof RoleGateRejectionError) {
        setSaveError(t("entry.roleDenied"));
      } else {
        // L13: generic failure. The old branch showed the phone-conflict copy
        // ("Phone already used by {name}") for ANY error, rendering the user's
        // own typed phone digits in the name slot — or an empty name on a
        // name-only save. Migration 007 dropped the phone UNIQUE constraint, so
        // a real conflict wouldn't even surface here; a plain save error should
        // read as one.
        setSaveError(t("entry.saveFailed"));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function pickLanguage(value: LocalePref) {
    setLangSheetVisible(false);
    if (value === localePref) return;
    setLocalePref(value);
    setLocale(value);
    await setAppMeta("locale_pref", value);
    toast.push(t("settings.language.changed"), "success");
  }

  // Same commit order as pickLanguage, and the order matters: close the sheet,
  // dedupe, local state, THEN the module global (which notifies subscribers and
  // repaints every mounted date), then persist, and toast last so the
  // confirmation itself is already rendered in the new calendar.
  async function pickCalendar(value: CalendarPref) {
    setCalSheetVisible(false);
    if (value === calendarPref) return;
    setCalendarPrefState(value);
    setCalendarPref(value);
    await setAppMeta(CALENDAR_PREF_KEY, value);
    toast.push(t("settings.calendar.changed"), "success");
  }

  // The tabular Qamari date can sit a day or two off the local moon sighting
  // (audit #15); this moves every Qamari date in the app, and new bills freeze
  // it. Same commit order as pickCalendar.
  async function pickQamariOffset(value: number) {
    setQamariSheetVisible(false);
    if (value === qamariOffset) return;
    setQamariOffsetState(value);
    setQamariOffset(value);
    await setAppMeta(QAMARI_OFFSET_KEY, String(value));
    toast.push(t("settings.qamariOffset.changed"), "success");
  }

  async function pickMessageLang(value: ShareLangPref) {
    setMsgLangSheetVisible(false);
    if (value === shareLangPref) return;
    setShareLangPref(value);
    await setAppMeta("share_lang_pref", value);
    toast.push(t("settings.messageLang.changed"), "success");
  }

  async function pickPrefCountry(code: string) {
    setPrefCountryVisible(false);
    if (code === prefCountry) return;
    setPrefCountry(code);
    setCurrentDefaultCountryCode(code);
    await setAppMeta("default_country_code", code);
    toast.push(t("preferences.country.changed"), "success");
  }

  if (!loaded) {
    // Same title / onBack / edges as the loaded branch below, so the chrome is
    // painted first and nothing moves when getLocalSelf() resolves. Previously
    // this was a bare spinner on a blank page: no title, and — because this
    // screen sets its own header — no back affordance at all while loading.
    return (
      <ScreenLoading
        title={t("account.title")}
        onBack={() => {
          if (!deletingRef.current) router.back();
        }}
        isRTL={isRTL}
        edges={["top"]}
      />
    );
  }

  const phoneC = getCountry(phoneCountry);
  const selectedLangLabelKey =
    LANGUAGE_OPTIONS.find((o) => o.value === localePref)?.labelKey ??
    "settings.language.option.system";
  const languageValue = t(selectedLangLabelKey as Parameters<typeof t>[0]);
  const msgLangLabelKey =
    MESSAGE_LANGUAGE_OPTIONS.find((o) => o.value === shareLangPref)?.labelKey ??
    "settings.messageLang.option.auto";
  const messageLangValue = t(msgLangLabelKey as Parameters<typeof t>[0]);
  const prefC = getCountry(prefCountry);

  // Calendar row + sheet. Every option carries a live example of TODAY in that
  // calendar, because "Solar Hijri" names a system a shopkeeper may not map to
  // a shape on sight — "۵ اسد ۱۴۰۵" does. One `now` for the whole render so the
  // sheet can't show two different days across its rows.
  const nowMs = Date.now();
  const resolveCalendar = (p: CalendarPref): Calendar =>
    p === "auto" ? (getLocale() === "fa" ? "jalali" : "gregorian") : p;
  const calendarExample = (p: CalendarPref): string =>
    formatCalendarDate(nowMs, getLocale(), resolveCalendar(p));
  const calendarValue = t(
    (CALENDAR_OPTIONS.find((o) => o.value === calendarPref)?.labelKey ??
      "settings.calendar.option.auto") as Parameters<typeof t>[0],
  );
  const qamariOffsetValue = t(
    (QAMARI_OFFSET_OPTIONS.find((o) => o.value === qamariOffset)?.labelKey ??
      "settings.qamariOffset.none") as Parameters<typeof t>[0],
  );
  // A digit follows, so Dari takes the comma: a middle dot there reads as a zero.
  const exampleSeparator = getLocale() === "fa" ? "، " : " · ";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader
        title={t("account.title")}
        onBack={() => {
          if (!deletingRef.current) router.back();
        }}
        isRTL={isRTL}
        backLabel={t("common.back")}
      />
      <KeyboardAvoidingView
        pointerEvents={deleting ? "none" : "auto"}
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 24 + insets.bottom * 0.25 }}
        >
          {/* ============ RETIRED INSTALL NOTICE ============
              First on the page. Signing in with the deleted account cancels
              the deletion within its 30-day window, so that comes first; the
              reset only opens the destructive confirmation. */}
          {retired ? (
            <View style={styles.retiredCard}>
              <Text style={[styles.retiredTitle, textDir(isRTL)]}>
                {t(retiredUntil ? "account.retired.pendingTitle" : "account.retired.title")}
              </Text>
              <Text style={[styles.retiredBody, textDir(isRTL)]}>
                {retiredUntil
                  ? t("account.retired.pendingBody", { date: formatDate(retiredUntil) })
                  : t("account.retired.body")}
              </Text>
              <View style={styles.retiredSignIn}>
                <Button
                  label={t(
                    retiredUntil ? "account.retired.signInCancel" : "menu.account.signIn.choose",
                  )}
                  onPress={() => router.push("/sign-in")}
                />
              </View>
              <Pressable
                onPress={() => setResetConfirmVisible(true)}
                accessibilityRole="button"
                accessibilityLabel={t("account.retired.reset")}
                style={({ pressed }) => [
                  styles.retiredAction,
                  pressed && { backgroundColor: colors.bgMuted },
                ]}
              >
                <Text style={styles.retiredActionText}>{t("account.retired.reset")}</Text>
              </Pressable>
            </View>
          ) : null}

          {/* ============ PROFILE ============ */}
          <SectionHeader label={t("account.profile.section")} isRTL={isRTL} />
          <View style={styles.formInset}>
            <Text style={[styles.label, textDir(isRTL)]}>
              {t("personEdit.name.label")} <Text style={styles.required}>*</Text>
            </Text>
            <View style={[styles.nameRow, rowDir(isRTL)]}>
              <TextInput
                style={[styles.nameInput, textDir(isRTL), nameError ? styles.inputError : null]}
                value={firstName}
                onChangeText={(v) => {
                  nameEditedRef.current = true;
                  setNameError(null);
                  setSaveError(null);
                  setFirstName(v);
                }}
                placeholder={t("personAdd.firstName.placeholder")}
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={t("personEdit.firstName.label")}
                autoCapitalize="words"
                autoCorrect={false}
                maxLength={40}
                returnKeyType="next"
                onSubmitEditing={() => lastNameRef.current?.focus()}
                submitBehavior="submit"
              />
              <TextInput
                ref={lastNameRef}
                style={[styles.nameInput, textDir(isRTL)]}
                value={lastName}
                onChangeText={(v) => {
                  nameEditedRef.current = true;
                  setNameError(null);
                  setSaveError(null);
                  setLastName(v);
                }}
                placeholder={t("personAdd.lastName.placeholder")}
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={t("personEdit.lastName.label")}
                autoCapitalize="words"
                autoCorrect={false}
                maxLength={40}
                returnKeyType="next"
                onSubmitEditing={() => phoneRef.current?.focus()}
                submitBehavior="submit"
              />
            </View>
            {nameError ? (
              <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
                {nameError}
              </Text>
            ) : null}

            <View style={{ height: 14 }} />
            <Text style={[styles.label, textDir(isRTL)]}>{t("personEdit.phone.label")}</Text>
            {/* Phone row stays physical-LTR (digits are LTR via Unicode bidi). */}
            <View style={styles.phoneRow}>
              <Pressable
                onPress={() => setPhonePickerVisible(true)}
                style={({ pressed }) => [
                  styles.countryBtn,
                  pressed && { backgroundColor: colors.bgMuted },
                ]}
              >
                <Text style={styles.countryFlag}>{phoneC.flag}</Text>
                <Text style={styles.countryDial}>{ltrIsolate(phoneC.dialCode)}</Text>
                <Ionicons name="chevron-down" size={icon.trailing} color={colors.textMuted} />
              </Pressable>
              <TextInput
                ref={phoneRef}
                style={[styles.phoneInput, phoneError ? styles.inputError : null]}
                value={phone}
                onChangeText={(v) => {
                  setPhoneError(null);
                  setSaveError(null);
                  setPhone(v);
                }}
                placeholder={
                  phoneC.code === "AF" ? "70 123 4567" : t("personAdd.phone.placeholderGeneric")
                }
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={t("personEdit.phone.label")}
                keyboardType="phone-pad"
                returnKeyType="done"
                onSubmitEditing={onSave}
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

            <View style={{ height: 14 }} />
            <Button label={t("account.save")} onPress={onSave} loading={saving} />
          </View>

          <SectionGap />

          {/* ============ SIGN-IN (signed in only) ============
              How this account signs in: its email (read-only), a Kaata
              password to set or change, and once a password exists the
              optional username that can stand in for the email. */}
          {hasSession ? (
            <>
              <SectionHeader label={t("account.signin.section")} isRTL={isRTL} />
              {me ? (
                <>
                  <View
                    style={[styles.infoRow, rowDir(isRTL)]}
                    accessible
                    accessibilityLabel={`${t("account.signin.email")}: ${me.email}`}
                  >
                    <Ionicons
                      name="mail-outline"
                      size={icon.row}
                      color={colors.textDefault}
                      style={isRTL ? { marginLeft: 14 } : { marginRight: 14 }}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.infoLabel, textDir(isRTL)]}>
                        {t("account.signin.email")}
                      </Text>
                      <Text style={[styles.infoValue, textDir(isRTL)]} numberOfLines={1}>
                        {me.email ? ltrIsolate(me.email) : "—"}
                      </Text>
                      {me.loginEmail && me.loginEmail.toLowerCase() !== me.email.toLowerCase() ? (
                        <Text style={[styles.infoHint, textDir(isRTL)]} numberOfLines={1}>
                          {t("account.signin.loginEmail", { email: ltrIsolate(me.loginEmail) })}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  <NavRow
                    icon="key-outline"
                    label={t(
                      me.hasPassword
                        ? "account.signin.password.change"
                        : "account.signin.password.set",
                    )}
                    hint={me.hasPassword ? undefined : t("account.signin.password.setHint")}
                    onPress={() => router.push("/account-password")}
                    isRTL={isRTL}
                    isLast={!me.hasPassword}
                  />
                  {me.hasPassword ? (
                    <NavRow
                      icon="at-outline"
                      label={t("account.signin.username")}
                      hint={t("account.signin.username.hint")}
                      trailing={
                        me.username ? ltrIsolate(me.username) : t("account.signin.username.none")
                      }
                      onPress={() => router.push("/account-username")}
                      isRTL={isRTL}
                      isLast={sessionKind !== "provider"}
                    />
                  ) : null}
                  {/* Only from a Google or Apple session (the server refuses an
                      email session): the way out when someone else added a
                      password to this account. */}
                  {me.hasPassword && sessionKind === "provider" ? (
                    <NavRow
                      icon="close-circle-outline"
                      label={t("account.signin.password.remove")}
                      hint={t("account.signin.password.removeHint")}
                      onPress={() => setRemoveConfirmVisible(true)}
                      isRTL={isRTL}
                      danger
                      isLast
                    />
                  ) : null}
                </>
              ) : meFailed ? (
                <NavRow
                  icon="refresh-outline"
                  label={t("account.signin.failed")}
                  onPress={() => void loadMe()}
                  isRTL={isRTL}
                  isLast
                />
              ) : (
                <Text style={[styles.infoLoading, textDir(isRTL)]}>
                  {t("account.signin.loading")}
                </Text>
              )}
              <SectionGap />
            </>
          ) : null}

          {/* ============ PREFERENCES (personal) ============ */}
          <SectionHeader label={t("account.preferences.section")} isRTL={isRTL} />
          <NavRow
            icon="language-outline"
            label={t("settings.language.label")}
            trailing={languageValue}
            onPress={() => setLangSheetVisible(true)}
            isRTL={isRTL}
          />
          {/* Directly under Language, because the two are read together and
              'auto' ties them: the hint shows TODAY in the active calendar, so
              the effect of either row is visible without opening a sheet. */}
          <NavRow
            icon="calendar-outline"
            label={t("settings.calendar.label")}
            hint={calendarExample(calendarPref)}
            trailing={calendarValue}
            onPress={() => setCalSheetVisible(true)}
            isRTL={isRTL}
          />
          {resolveCalendar(calendarPref) === "qamari" ? (
            <NavRow
              icon="moon-outline"
              label={t("settings.qamariOffset.label")}
              hint={t("settings.qamariOffset.hint")}
              trailing={qamariOffsetValue}
              onPress={() => setQamariSheetVisible(true)}
              isRTL={isRTL}
            />
          ) : null}
          <NavRow
            icon="chatbubble-ellipses-outline"
            label={t("settings.messageLang.label")}
            hint={t("settings.messageLang.hint")}
            trailing={messageLangValue}
            onPress={() => setMsgLangSheetVisible(true)}
            isRTL={isRTL}
          />
          <NavRow
            icon="flag-outline"
            label={t("preferences.country.label")}
            hint={t("preferences.country.hint")}
            trailing={`${prefC.flag}  ${prefC.name}`}
            onPress={() => setPrefCountryVisible(true)}
            isRTL={isRTL}
            isLast
          />

          <SectionGap />

          {/* ============ PRIVACY & DATA ============ */}
          <Stack.Screen options={{ gestureEnabled: !deleting }} />
          {deletionRecoveryNeeded ? (
            <View style={styles.retiredCard}>
              <Text style={[styles.retiredBody, textDir(isRTL)]}>
                {t("account.deleteAccount.lateEdits")}
              </Text>
              <Button
                label={t("menu.account.signIn.choose")}
                onPress={() => router.push("/sign-in")}
              />
            </View>
          ) : null}
          <SectionHeader label={t("account.privacy.section")} isRTL={isRTL} />
          <NavRow
            icon="shield-checkmark-outline"
            label={t("account.privacy.label")}
            onPress={() => {
              void Linking.openURL(PRIVACY_URL);
            }}
            isRTL={isRTL}
            isLast={!signedIn}
          />
          {signedIn ? (
            <NavRow
              icon="trash-outline"
              label={t(
                deleting ? "account.deleteAccount.preparing" : "account.deleteAccount.label",
              )}
              hint={t("account.deleteAccount.hint")}
              onPress={() => {
                if (!deletingRef.current) setDeleteConfirmVisible(true);
              }}
              isRTL={isRTL}
              danger
              isLast
            />
          ) : null}

          {/* Flex spacer: pushes App health to the BOTTOM of the page on tall
              screens (space-between feel), and collapses to a small gap when the
              content above overflows and the page has to scroll. */}
          <View style={styles.healthSpacer} />

          {/* ============ APP HEALTH (bottom-pinned) ============
              Just an entry point into /diagnostics, which now owns the version +
              build details and the copy-report flow. */}
          <SectionHeader label={t("account.appHealth.section")} isRTL={isRTL} />
          <NavRow
            icon="pulse-outline"
            label={t("account.appHealth.details")}
            hint={t("account.appHealth.detailsHint")}
            onPress={() => router.push("/diagnostics")}
            isRTL={isRTL}
            isLast
          />
        </ScrollView>
      </KeyboardAvoidingView>

      <CountryPickerSheet
        visible={phonePickerVisible}
        selectedCode={phoneCountry}
        onSelect={(c) => setPhoneCountry(c)}
        onDismiss={() => setPhonePickerVisible(false)}
      />
      <OptionSheet
        visible={langSheetVisible}
        title={t("settings.language.label")}
        options={LANGUAGE_OPTIONS.map((o) => ({
          key: o.value,
          label: t(o.labelKey as Parameters<typeof t>[0]),
        }))}
        selected={localePref}
        onSelect={(k) => pickLanguage(k as LocalePref)}
        onDismiss={() => setLangSheetVisible(false)}
        isRTL={isRTL}
      />
      <OptionSheet
        visible={calSheetVisible}
        title={t("settings.calendar.label")}
        options={CALENDAR_OPTIONS.map((o) => ({
          key: o.value,
          // "Solar Hijri · ۵ اسد ۱۴۰۵" — the name alone doesn't tell a
          // shopkeeper what they're choosing; the worked example does.
          label: `${t(o.labelKey as Parameters<typeof t>[0])} · ${calendarExample(o.value)}`,
          hint: o.value === "qamari" ? t("settings.calendar.hint.qamari") : undefined,
        }))}
        selected={calendarPref}
        onSelect={(k) => pickCalendar(k as CalendarPref)}
        onDismiss={() => setCalSheetVisible(false)}
        isRTL={isRTL}
      />
      <OptionSheet
        visible={qamariSheetVisible}
        title={t("settings.qamariOffset.label")}
        options={QAMARI_OFFSET_OPTIONS.map((o) => ({
          key: String(o.value),
          // Each choice shows today as it would read, like the calendar sheet.
          label: `${t(o.labelKey as Parameters<typeof t>[0])}${exampleSeparator}${formatCalendarDate(nowMs, getLocale(), "qamari", o.value)}`,
        }))}
        selected={String(qamariOffset)}
        onSelect={(k) => pickQamariOffset(Number(k))}
        onDismiss={() => setQamariSheetVisible(false)}
        isRTL={isRTL}
      />
      <OptionSheet
        visible={msgLangSheetVisible}
        title={t("settings.messageLang.label")}
        options={MESSAGE_LANGUAGE_OPTIONS.map((o) => ({
          key: o.value,
          label: t(o.labelKey as Parameters<typeof t>[0]),
        }))}
        selected={shareLangPref}
        onSelect={(k) => pickMessageLang(k as ShareLangPref)}
        onDismiss={() => setMsgLangSheetVisible(false)}
        isRTL={isRTL}
      />
      <CountryPickerSheet
        visible={prefCountryVisible}
        selectedCode={prefCountry}
        onSelect={pickPrefCountry}
        onDismiss={() => setPrefCountryVisible(false)}
      />
      <ConfirmDialog
        visible={deleteConfirmVisible}
        title={t("account.deleteAccount.confirm.title")}
        description={t("account.deleteAccount.confirm.body")}
        confirmLabel={t("account.deleteAccount.confirm.cta")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={onConfirmDelete}
        onCancel={() => setDeleteConfirmVisible(false)}
      />
      <ConfirmDialog
        visible={removeConfirmVisible}
        title={t("accountPassword.remove.title")}
        description={t("accountPassword.remove.body")}
        confirmLabel={t("accountPassword.remove.cta")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={onConfirmRemovePassword}
        onCancel={() => setRemoveConfirmVisible(false)}
      />
      <ConfirmDialog
        visible={resetConfirmVisible}
        title={t("account.retired.confirm.title")}
        description={t("account.retired.confirm.body")}
        confirmLabel={t("account.retired.confirm.cta")}
        cancelLabel={t("common.cancel")}
        destructive
        onConfirm={onConfirmReset}
        onCancel={() => setResetConfirmVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  formInset: { paddingHorizontal: 20, paddingTop: 4 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  required: { color: colors.danger },
  nameRow: { flexDirection: "row", gap: 10 },
  nameInput: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
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
    // Already at the HIG floor; named so it tracks TOUCH_MIN if that moves.
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
    backgroundColor: colors.bgDefault,
  },
  countryFlag: { fontSize: 18 },
  countryDial: { fontSize: 14, fontFamily: fonts.monoMedium, color: colors.textEmphasis },
  phoneInput: {
    flex: 1,
    minHeight: TOUCH_MIN,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
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
    marginTop: 6,
  },
  // Pushes the App-health section to the bottom; minHeight keeps a little air
  // between it and Preferences when the page is short enough not to scroll.
  healthSpacer: { flex: 1, minHeight: 24 },
  // Retired-install notice. A calm card on the settings gutter; the red label
  // marks its one action the way "Delete account" is marked.
  retiredCard: {
    marginHorizontal: 20,
    marginTop: 12,
    padding: 16,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
  },
  retiredTitle: { ...typography.labelBold, color: colors.textEmphasis },
  retiredBody: { ...typography.bodySm, color: colors.textDefault, marginTop: 6 },
  retiredSignIn: { marginTop: 12 },
  retiredAction: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: TOUCH_MIN,
    marginTop: 12,
    paddingHorizontal: 16,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgDefault,
  },
  retiredActionText: { ...typography.labelBold, color: colors.danger },
  // A read-only row in the settings rhythm (NavRow's gutter and height).
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: ROW_MIN,
    paddingHorizontal: gutter.settings,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  infoLabel: { ...typography.hint, color: colors.textSubtle },
  infoValue: { ...typography.label, color: colors.textEmphasis },
  infoHint: { ...typography.hint, color: colors.textSubtle },
  infoLoading: {
    ...typography.bodySm,
    color: colors.textMuted,
    paddingHorizontal: gutter.settings,
    paddingVertical: 14,
  },
});
