import type { TextInputInstance } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Keyboard,
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
import { BottomSheet } from "../../../components/BottomSheet";
import { Button } from "../../../components/Button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { CountryPickerSheet } from "../../../components/CountryPickerSheet";
import { OptionSheet } from "../../../components/OptionSheet";
import { ScreenLoading } from "../../../components/ScreenLoading";
import { NavRow, ScreenHeader } from "../../../components/SettingsScreen";
import { queuePendingToast, useToast } from "../../../components/Toast";
import { colors } from "../../../lib/colors";
import { SETTINGS_DISABLED_OPACITY } from "../../../lib/design-tokens";
import { splitName } from "../../../lib/contacts-sync";
import { archivePerson, getPerson, updatePerson } from "../../../lib/db";
import { captureCurrentSession, SessionChangedError } from "../../../lib/auth";
import {
  getCurrencyLabel,
  getCurrencyName,
  getDefaultEntryCurrency,
  getEnabledCurrencies,
} from "../../../lib/currency";
import { getPersonDefaultCurrency } from "../../../lib/person-currency";
import { ltrIsolate, rowDir, textDir, useIsRTL } from "../../../lib/direction";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../../../lib/event-log";
import { fonts } from "../../../lib/fonts";
import { t } from "../../../lib/i18n";
import { getCountry, getCurrentDefaultCountryCode, inferCountryFromE164 } from "../../../lib/phone";
import { icon, radius, TOUCH_MIN } from "../../../lib/tokens";
import { getAccountIdSync, getActiveVaultIdSyncMaybe, getInstallIdSync } from "../../../lib/db-tx";
import { useCustomerGroups } from "../../../lib/use-customer-groups";
import { useActiveVaultWriteCaps } from "../../../lib/use-vault-role";

// presentation:"modal" screen: the loaded branch is a bare <SafeAreaView>,
// which insets all four edges. ScreenLoading defaults to ["top"] (the pushed-
// screen case), so the pre-content branches have to spell this out or the
// header shifts the moment the read resolves.
const MODAL_EDGES = ["top", "bottom", "left", "right"] as const;
const INHERIT_CURRENCY = "kaata-default";
type EditScope = {
  id: string;
  vaultId: string | null;
  accountId: string | null;
  installId: string;
};
type EditAttempt = EditScope & { focus: number };

export default function EditPersonScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const vaultId = getActiveVaultIdSyncMaybe();
  const accountId = getAccountIdSync();
  const installId = getInstallIdSync();
  const groupState = useCustomerGroups(vaultId);
  const caps = useActiveVaultWriteCaps(vaultId);
  const personGroupIds = groupState.groupsByPerson[id] ?? [];
  const groupName = groupState.groups
    .filter((g) => personGroupIds.includes(g.id))
    .map((g) => g.name)
    .join(" · ");
  const [loaded, setLoaded] = useState(false);
  // A null getPerson (stale id, archived remotely via mesh) used to fall
  // through to a blank editable form that saved into nothing. Mirrors
  // entry/[id]/edit.tsx's `found`.
  const [found, setFound] = useState(false);
  // Distinguishes "this person isn't there" from "the read failed". Telling a
  // shopkeeper their contact was not found because a storage read blipped is a
  // false data-loss signal — the worst lie a ledger can tell. app/person/[id].tsx
  // already splits these two; this screen now matches it.
  const [loadFailed, setLoadFailed] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  // Defaults to the user's preferred country. Overwritten on load via
  // inferCountryFromE164(person.phone) when the existing contact has a
  // phone — only matters as the visible default while the data loads,
  // and as the fallback for contacts saved without a phone number.
  const [countryCode, setCountryCode] = useState(getCurrentDefaultCountryCode);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [defaultCurrency, setDefaultCurrency] = useState<string | null>(null);
  const defaultCurrencyRef = useRef<string | null>(null);
  const originalDefaultCurrency = useRef<string | null>(null);
  const [enabledCurrencies, setEnabledCurrencies] = useState<readonly string[]>([]);
  const enabledCurrenciesRef = useRef<readonly string[]>([]);
  const [kaataDefault, setKaataDefault] = useState("");
  const [currencyPickerVisible, setCurrencyPickerVisible] = useState(false);
  const currencyPickerAttempt = useRef<EditAttempt | null>(null);
  // Inline errors — modal screen, toasts can't render above it (Toast.tsx).
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const firstNameRef = useRef<TextInputInstance>(null);
  const lastNameRef = useRef<TextInputInstance>(null);
  const phoneRef = useRef<TextInputInstance>(null);
  // Synchronous re-entry guard — `busy` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx.
  const savingRef = useRef(false);
  const country = getCountry(countryCode);
  // Remove-person confirm (archive semantics — see the danger row below).
  const [confirmRemove, setConfirmRemove] = useState(false);
  const removingRef = useRef(false);
  const mounted = useRef(true);
  const focused = useRef(false);
  const focusGeneration = useRef(0);
  const [, setFocusVersion] = useState(0);
  const loadedScope = useRef<string | null>(null);
  const scope = { id, vaultId, accountId, installId };
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const capsRef = useRef(caps);
  capsRef.current = caps;
  const scopeKey = JSON.stringify([id, vaultId, accountId, installId]);
  const hasScope = (attempt: EditAttempt) =>
    mounted.current &&
    scopeRef.current.id === attempt.id &&
    getActiveVaultIdSyncMaybe() === attempt.vaultId &&
    getAccountIdSync() === attempt.accountId &&
    getInstallIdSync() === attempt.installId;
  const isCurrent = (attempt: EditAttempt) =>
    hasScope(attempt) && focused.current && attempt.focus === focusGeneration.current;
  const canEdit = (attempt: EditAttempt) =>
    isCurrent(attempt) && !!attempt.vaultId && capsRef.current.resolved && capsRef.current.canAmend;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      const attempt: EditAttempt = {
        id,
        vaultId,
        accountId,
        installId,
        focus: ++focusGeneration.current,
      };
      setFocusVersion(attempt.focus);
      const alreadyLoaded = loadedScope.current === scopeKey;
      currencyPickerAttempt.current = null;
      setCurrencyPickerVisible(false);
      setPickerVisible(false);
      if (!alreadyLoaded) {
        setLoaded(false);
        setFound(false);
        setLoadFailed(false);
        setBusy(false);
        setSaveError(null);
        setNameError(null);
        setPhoneError(null);
      }
      void (async () => {
        try {
          if (!attempt.id || !attempt.vaultId) {
            if (isCurrent(attempt)) setLoaded(true);
            return;
          }
          const [p, rawDefault, enabled, bookDefault] = await Promise.all([
            alreadyLoaded ? null : getPerson(attempt.id),
            alreadyLoaded ? null : getPersonDefaultCurrency(attempt.vaultId, attempt.id),
            getEnabledCurrencies(attempt.vaultId),
            getDefaultEntryCurrency(attempt.vaultId),
          ]);
          if (!isCurrent(attempt)) return;
          enabledCurrenciesRef.current = enabled;
          setEnabledCurrencies(enabled);
          setKaataDefault(bookDefault);
          if (alreadyLoaded) return;
          if (p) {
            const name = splitName(p.name);
            setFirstName(name.firstName);
            setLastName(name.lastName ?? "");
            const inferred = p.phone
              ? inferCountryFromE164(p.phone)
              : getCurrentDefaultCountryCode();
            const dial = getCountry(inferred).dialCode;
            setCountryCode(inferred);
            setPhone(
              p.phone ? (p.phone.startsWith(dial) ? p.phone.slice(dial.length) : p.phone) : "",
            );
            originalDefaultCurrency.current = rawDefault;
            defaultCurrencyRef.current = rawDefault;
            setDefaultCurrency(rawDefault);
            setFound(true);
            loadedScope.current = scopeKey;
          }
          setLoaded(true);
        } catch (err) {
          if (!isCurrent(attempt)) return;
          console.warn("[person/edit] load failed", err);
          if (alreadyLoaded) setSaveError(t("home.loadFailed"));
          else {
            setLoadFailed(true);
            setLoaded(true);
          }
        }
      })();
      return () => {
        focused.current = false;
        focusGeneration.current++;
        currencyPickerAttempt.current = null;
        if (mounted.current) {
          setCurrencyPickerVisible(false);
          setPickerVisible(false);
          setConfirmRemove(false);
        }
      };
      // Live refs validate retained handlers; a new scope must load its own draft.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, vaultId, accountId, installId, scopeKey]),
  );

  const renderAttempt: EditAttempt = { ...scope, focus: focusGeneration.current };
  const currentDraft = loadedScope.current === scopeKey;
  const editable = currentDraft && canEdit(renderAttempt) && !busy;
  const currencySelectable = enabledCurrencies.length > 1 || defaultCurrency !== null;
  const unavailableDefault =
    defaultCurrency !== null && !enabledCurrencies.includes(defaultCurrency);
  const inheritedLabel = t("personEdit.currency.inherit", {
    currency: getCurrencyLabel(kaataDefault),
  });
  const pickerAttempt = currencyPickerAttempt.current;
  const currencyOptions = [
    { key: INHERIT_CURRENCY, label: inheritedLabel },
    ...enabledCurrencies.map((code) => ({
      key: code,
      label: getCurrencyName(code),
      hint: ltrIsolate(getCurrencyLabel(code)),
    })),
  ];

  // Reliable keyboard pop-up on Android — see entry/[id]/edit for context.
  useEffect(() => {
    if (!loaded || !editable) return;
    const attempt = renderAttempt;
    const focusTimer = setTimeout(() => {
      if (canEdit(attempt) && !savingRef.current && !currencyPickerAttempt.current)
        firstNameRef.current?.focus();
    }, 280);
    return () => clearTimeout(focusTimer);
    // Focus only when entering the loaded form, not after each draft edit/save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, scopeKey]);

  async function onRemove() {
    const attempt = renderAttempt;
    if (!canEdit(attempt) || savingRef.current || removingRef.current) return;
    setConfirmRemove(false);
    removingRef.current = true;
    try {
      await archivePerson(attempt.id, { vaultId: attempt.vaultId!, accountId: attempt.accountId });
      if (!isCurrent(attempt)) return;
      // The toast must outlive this modal AND the person screen beneath it —
      // queue it for the home screen's drain (see Toast.tsx contract).
      queuePendingToast(
        t("common.removed", { name: [firstName, lastName].filter(Boolean).join(" ") }),
        "success",
      );
      router.replace("/");
    } catch (err) {
      if (!isCurrent(attempt)) return;
      if (err instanceof RoleGateRejectionError) {
        setSaveError(t("entry.roleDenied"));
      } else {
        console.warn("[person/edit] archivePerson failed", err);
        setSaveError(t("entry.deleteFailed"));
      }
    } finally {
      removingRef.current = false;
    }
  }

  async function onSave() {
    const attempt = renderAttempt;
    if (savingRef.current || removingRef.current || !currentDraft || !canEdit(attempt)) return;
    const fn = firstName.trim();
    if (!fn) {
      setNameError(t("onboarding.nameRequired"));
      return;
    }
    savingRef.current = true;
    currencyPickerAttempt.current = null;
    setCurrencyPickerVisible(false);
    setPickerVisible(false);
    setBusy(true);
    setSaveError(null);
    try {
      const session = await captureCurrentSession();
      if (!canEdit(attempt) || session.accountId !== attempt.accountId) return;
      const chosenDefault = defaultCurrencyRef.current;
      const originalDefault = originalDefaultCurrency.current;
      const result = await updatePerson(
        attempt.id,
        fn,
        lastName.trim() || null,
        phone.trim() || null,
        countryCode,
        {
          session,
          vaultId: attempt.vaultId!,
          shouldContinue: () => canEdit(attempt),
          ...(chosenDefault !== originalDefault
            ? { defaultCurrency: chosenDefault, expectedDefaultCurrency: originalDefault }
            : {}),
        },
      );
      if (!isCurrent(attempt)) return;
      if (!result.ok) {
        if (result.error === "phone_invalid") {
          setPhoneError(t("personAdd.phone.invalid"));
        } else if (result.error === "phone_is_self") {
          setPhoneError(t("personAdd.phone.isSelf"));
        } else {
          setPhoneError(t("personAdd.phone.conflict", { name: result.existing.name }));
        }
        return;
      }
      toast.push(t("settings.saved"), "success");
      router.back();
    } catch (err) {
      if (!isCurrent(attempt) || err instanceof SessionChangedError) return;
      // Without this catch a thrown updatePerson (role demotion landing
      // via mesh, signing unavailable, storage error) was a completely
      // silent failure — spinner stopped, nothing saved, no feedback.
      if (err instanceof RoleGateRejectionError) {
        setSaveError(t("entry.roleDenied"));
      } else if (err instanceof EventSigningUnavailableError) {
        setSaveError(t("entry.signingUnavailable"));
      } else {
        setSaveError(t("entry.saveFailed"));
      }
    } finally {
      savingRef.current = false;
      if (hasScope(attempt)) setBusy(false);
    }
  }

  if (!loaded || (found && !currentDraft)) {
    return (
      <ScreenLoading
        title={t("personEdit.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        edges={MODAL_EDGES}
      />
    );
  }

  if (!found) {
    // Same two-way split app/person/[id].tsx makes: a transient read failure
    // says "couldn't load", only a genuinely absent row says "not found".
    return (
      <ScreenLoading
        title={t("personEdit.title")}
        onBack={() => router.back()}
        isRTL={isRTL}
        message={loadFailed ? t("home.loadFailed") : t("personAdd.personNotFound")}
        edges={MODAL_EDGES}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* The "Cancel" word becomes the shared chevron; it survives as the a11y
label so TalkBack still announces "Cancel", not "Back". */}
      <ScreenHeader
        title={t("personEdit.title")}
        onBack={() => {
          if (isCurrent(renderAttempt) && !savingRef.current && !removingRef.current) router.back();
        }}
        isRTL={isRTL}
        backLabel={t("common.cancel")}
      />
      <KeyboardAvoidingView
        style={styles.keyboardBody}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.field}>
            <Text style={[styles.label, textDir(isRTL)]}>
              {t("personEdit.name.label")} <Text style={styles.required}>*</Text>
            </Text>
            <View style={[styles.nameRow, rowDir(isRTL)]}>
              <TextInput
                ref={firstNameRef}
                style={[
                  styles.nameInput,
                  textDir(isRTL),
                  nameError ? styles.inputError : null,
                  !editable && styles.inputDisabled,
                ]}
                value={firstName}
                editable={editable}
                accessibilityState={{ disabled: !editable }}
                onChangeText={(v) => {
                  if (!canEdit(renderAttempt) || savingRef.current) return;
                  setNameError(null);
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
                style={[styles.nameInput, textDir(isRTL), !editable && styles.inputDisabled]}
                value={lastName}
                editable={editable}
                accessibilityState={{ disabled: !editable }}
                onChangeText={(v) => {
                  if (canEdit(renderAttempt) && !savingRef.current) setLastName(v);
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
          </View>
          <View style={styles.field}>
            <Text style={[styles.label, textDir(isRTL)]}>{t("personEdit.phone.label")}</Text>
            {/* Phone row stays physical-LTR; numbers are LTR-natural via
              Unicode bidi. See the matching comment in person/new.tsx. */}
            <View style={styles.phoneRow}>
              <Pressable
                disabled={!editable}
                accessibilityRole="button"
                accessibilityState={{ disabled: !editable }}
                onPress={() => {
                  if (canEdit(renderAttempt) && !savingRef.current) setPickerVisible(true);
                }}
                style={({ pressed }) => [
                  styles.countryBtn,
                  pressed && editable && { backgroundColor: colors.bgMuted },
                  !editable && styles.countryDisabled,
                ]}
              >
                <Text style={styles.countryFlag}>{country.flag}</Text>
                <Text style={styles.countryDial}>{ltrIsolate(country.dialCode)}</Text>
                <Ionicons name="chevron-down" size={icon.trailing} color={colors.textMuted} />
              </Pressable>
              <TextInput
                ref={phoneRef}
                style={[
                  styles.phoneInput,
                  phoneError ? styles.inputError : null,
                  !editable && styles.inputDisabled,
                ]}
                value={phone}
                editable={editable}
                accessibilityState={{ disabled: !editable }}
                onChangeText={(v) => {
                  if (!canEdit(renderAttempt) || savingRef.current) return;
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
                onSubmitEditing={onSave}
              />
            </View>
            {phoneError ? (
              <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
                {phoneError}
              </Text>
            ) : null}
          </View>
          <NavRow
            icon="cash-outline"
            label={t("personEdit.currency.label")}
            hint={
              unavailableDefault
                ? t("personEdit.currency.unavailable", {
                    currency: getCurrencyLabel(defaultCurrency!),
                  })
                : undefined
            }
            trailing={
              defaultCurrency === null
                ? t("personEdit.currency.inherited")
                : getCurrencyLabel(defaultCurrency)
            }
            accessibilityLabel={`${t("personEdit.currency.label")}, ${defaultCurrency === null ? inheritedLabel : getCurrencyLabel(defaultCurrency)}`}
            accessibilityHint={
              unavailableDefault
                ? t("personEdit.currency.unavailable", {
                    currency: getCurrencyLabel(defaultCurrency!),
                  })
                : t("personEdit.currency.hint")
            }
            isRTL={isRTL}
            disabled={!editable || !currencySelectable}
            onPress={() => {
              if (!canEdit(renderAttempt) || savingRef.current || !currencySelectable) return;
              Keyboard.dismiss();
              currencyPickerAttempt.current = { ...renderAttempt };
              setCurrencyPickerVisible(true);
            }}
          />
          {caps.resolved && caps.canAmend && vaultId ? (
            <NavRow
              icon="pricetags-outline"
              label={t("groups.personAction")}
              trailing={groupName || t("groups.none")}
              isRTL={isRTL}
              disabled={!editable}
              onPress={() => {
                if (canEdit(renderAttempt) && !savingRef.current)
                  router.push({ pathname: "/person/[id]/group", params: { id, vaultId } });
              }}
            />
          ) : null}
          {saveError ? (
            <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {saveError}
            </Text>
          ) : null}
          <View style={{ height: 24 }} />
          <Button
            label={t("personEdit.save")}
            onPress={onSave}
            loading={busy}
            disabled={!editable}
          />

          {/* Remove person — the ONE place removal works for every contact.
            The home list's long-press remove only exists for people WITH
            tallies (zero-tally contacts never appear there), which left
            phone-book imports and typo-adds undeletable. Same archive
            semantics as home: relationship archived (entries kept as
            history), phone number freed for re-use. */}
          <Pressable
            onPress={() => {
              if (canEdit(renderAttempt) && !savingRef.current) setConfirmRemove(true);
            }}
            disabled={!editable}
            accessibilityRole="button"
            accessibilityState={{ disabled: !editable }}
            style={({ pressed }) => [
              styles.removeRow,
              pressed && editable && { opacity: 0.7 },
              !editable && { opacity: SETTINGS_DISABLED_OPACITY },
            ]}
          >
            <Text style={[styles.removeRowText, !editable && { color: colors.textMuted }]}>
              {t("common.remove.title", { name: [firstName, lastName].filter(Boolean).join(" ") })}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={confirmRemove}
        title={t("common.remove.title", {
          name: [firstName, lastName].filter(Boolean).join(" "),
        })}
        description={t("common.remove.description")}
        confirmLabel={t("common.remove")}
        destructive
        onConfirm={onRemove}
        onCancel={() => setConfirmRemove(false)}
      />

      <CountryPickerSheet
        visible={pickerVisible && editable}
        selectedCode={countryCode}
        onSelect={(c) => {
          if (pickerVisible && canEdit(renderAttempt) && !savingRef.current) setCountryCode(c);
        }}
        onDismiss={() => {
          if (isCurrent(renderAttempt)) setPickerVisible(false);
        }}
      />
      <OptionSheet
        visible={currencyPickerVisible && editable}
        title={t("personEdit.currency.label")}
        options={currencyOptions}
        selected={defaultCurrency ?? INHERIT_CURRENCY}
        isRTL={isRTL}
        onSelect={(code) => {
          if (
            !pickerAttempt ||
            currencyPickerAttempt.current !== pickerAttempt ||
            !canEdit(pickerAttempt) ||
            savingRef.current ||
            (code !== INHERIT_CURRENCY && !enabledCurrenciesRef.current.includes(code))
          )
            return;
          currencyPickerAttempt.current = null;
          const next = code === INHERIT_CURRENCY ? null : code;
          defaultCurrencyRef.current = next;
          setDefaultCurrency(next);
          setCurrencyPickerVisible(false);
          setSaveError(null);
        }}
        onDismiss={() => {
          if (
            !pickerAttempt ||
            currencyPickerAttempt.current !== pickerAttempt ||
            !isCurrent(pickerAttempt)
          )
            return;
          currencyPickerAttempt.current = null;
          setCurrencyPickerVisible(false);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  keyboardBody: { flex: 1 },
  body: { padding: 16, paddingTop: 24 },
  field: { marginBottom: 20 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  required: { color: colors.danger },
  input: {
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
  // First + last name, side by side (matches the phone Contacts app).
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
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radius.sm,
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
  inputDisabled: {
    backgroundColor: colors.bgMuted,
    borderColor: colors.borderSubtle,
    color: colors.textMuted,
  },
  countryDisabled: {
    backgroundColor: colors.bgMuted,
    borderColor: colors.borderSubtle,
    opacity: SETTINGS_DISABLED_OPACITY,
  },
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
  },
  removeRow: {
    minHeight: TOUCH_MIN,
    marginTop: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  removeRowText: {
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
  },
});
