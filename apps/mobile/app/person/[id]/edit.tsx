import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../../components/Button";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { CountryPickerSheet } from "../../../components/CountryPickerSheet";
import { queuePendingToast, useToast } from "../../../components/Toast";
import { colors } from "../../../lib/colors";
import { splitName } from "../../../lib/contacts-sync";
import { archivePerson, getPerson, updatePerson } from "../../../lib/db";
import { rowDir, textDir, useIsRTL } from "../../../lib/direction";
import { EventSigningUnavailableError, RoleGateRejectionError } from "../../../lib/event-log";
import { fonts } from "../../../lib/fonts";
import { t } from "../../../lib/i18n";
import { getCountry, getCurrentDefaultCountryCode, inferCountryFromE164 } from "../../../lib/phone";
import { countSharedLinksForPerson, revokeSharedLinksForPerson } from "../../../lib/share";

export default function EditPersonScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loaded, setLoaded] = useState(false);
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
  // Inline errors — modal screen, toasts can't render above it (Toast.tsx).
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const firstNameRef = useRef<TextInput>(null);
  const lastNameRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  // Synchronous re-entry guard — `busy` state can't stop a same-frame
  // double-tap (setState is async); see entry/new.tsx.
  const savingRef = useRef(false);
  const country = getCountry(countryCode);
  // Remove-person confirm (archive semantics — see the danger row below).
  const [confirmRemove, setConfirmRemove] = useState(false);
  const removingRef = useRef(false);
  // Shared-link revocation (see lib/share.ts registry): count drives the
  // affordance; result renders inline (modal screen, toasts can't).
  const [sharedLinkCount, setSharedLinkCount] = useState(0);
  const [revoking, setRevoking] = useState(false);
  const [revokeResult, setRevokeResult] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    countSharedLinksForPerson(id)
      .then(setSharedLinkCount)
      .catch(() => setSharedLinkCount(0));
  }, [id]);

  async function onRevokeLinks() {
    if (!id || revoking) return;
    setRevoking(true);
    setRevokeResult(null);
    try {
      const dead = await revokeSharedLinksForPerson(id);
      const remaining = await countSharedLinksForPerson(id);
      setSharedLinkCount(remaining);
      setRevokeResult(
        remaining === 0
          ? t("personEdit.revokeLinks.done")
          : t("personEdit.revokeLinks.partial", { count: remaining }),
      );
      if (dead === 0 && remaining > 0) setRevokeResult(t("personEdit.revokeLinks.failed"));
    } catch (err) {
      console.warn("[person/edit] link revocation failed", err);
      setRevokeResult(t("personEdit.revokeLinks.failed"));
    } finally {
      setRevoking(false);
    }
  }

  useEffect(() => {
    if (!id) return;
    getPerson(id)
      .then((p) => {
        if (p) {
          // kaata stores one display_name; the edit UI shows it as first + last
          // (matching the phone Contacts app). Split on the first space: single-
          // word names keep an empty last name. See contacts-sync.splitName.
          const s = splitName(p.name);
          setFirstName(s.firstName);
          setLastName(s.lastName ?? "");
          if (p.phone) {
            // Split stored E.164 into (country, national) so the picker shows
            // the right flag and the input shows just the national digits.
            const inferred = inferCountryFromE164(p.phone);
            const dial = getCountry(inferred).dialCode;
            setCountryCode(inferred);
            setPhone(p.phone.startsWith(dial) ? p.phone.slice(dial.length) : p.phone);
          } else {
            setPhone("");
          }
        }
        setLoaded(true);
      })
      .catch((err) => {
        // A rejected read must still flip `loaded`, else this modal is a
        // permanent spinner with no header/back. Render the not-found branch.
        console.warn("[person/edit] load failed", err);
        setLoaded(true);
      });
  }, [id]);

  // Reliable keyboard pop-up on Android — see entry/[id]/edit for context.
  useEffect(() => {
    if (!loaded) return;
    const focusTimer = setTimeout(() => firstNameRef.current?.focus(), 280);
    return () => clearTimeout(focusTimer);
  }, [loaded]);

  async function onRemove() {
    setConfirmRemove(false);
    if (!id || removingRef.current) return;
    removingRef.current = true;
    try {
      await archivePerson(id);
      // The toast must outlive this modal AND the person screen beneath it —
      // queue it for the home screen's drain (see Toast.tsx contract).
      queuePendingToast(
        t("common.removed", { name: [firstName, lastName].filter(Boolean).join(" ") }),
        "success",
      );
      router.replace("/");
    } catch (err) {
      if (err instanceof RoleGateRejectionError) {
        setSaveError(t("entry.roleDenied"));
      } else {
        console.warn("[person/edit] archivePerson failed", err);
        setSaveError(t("entry.deleteFailed"));
      }
      removingRef.current = false;
    }
  }

  async function onSave() {
    if (savingRef.current || !id) return;
    const fn = firstName.trim();
    if (!fn) {
      setNameError(t("onboarding.nameRequired"));
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setSaveError(null);
    try {
      const result = await updatePerson(
        id,
        fn,
        lastName.trim() || null,
        phone.trim() || null,
        countryCode,
      );
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
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.fillCenter}>
          <ActivityIndicator color={colors.textDefault} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={[styles.header, rowDir(isRTL)]}>
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.cancel, textDir(isRTL)]}>{t("common.cancel")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("personEdit.title")}</Text>
        <View style={{ width: 60 }} />
      </View>
      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.field}>
          <Text style={[styles.label, textDir(isRTL)]}>
            {t("personEdit.name.label")} <Text style={styles.required}>*</Text>
          </Text>
          <View style={[styles.nameRow, rowDir(isRTL)]}>
            <TextInput
              ref={firstNameRef}
              style={[styles.nameInput, textDir(isRTL), nameError ? styles.inputError : null]}
              value={firstName}
              onChangeText={(v) => {
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
              style={[styles.nameInput, textDir(isRTL)]}
              value={lastName}
              onChangeText={setLastName}
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
              onSubmitEditing={onSave}
            />
          </View>
          {phoneError ? (
            <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
              {phoneError}
            </Text>
          ) : null}
        </View>
        {saveError ? (
          <Text style={[styles.fieldError, textDir(isRTL)]} accessibilityLiveRegion="polite">
            {saveError}
          </Text>
        ) : null}
        <View style={{ height: 24 }} />
        <Button label={t("personEdit.save")} onPress={onSave} loading={busy} />

        {/* Revoke shared ledger links (2026-07-26 hardening). Rendered only
            when THIS DEVICE minted still-tracked links for this person; kills
            them server-side early instead of waiting out the 30-day TTL.
            Inline result text, not a toast — modal screen (Toast.tsx). */}
        {sharedLinkCount > 0 ? (
          <Pressable
            onPress={onRevokeLinks}
            disabled={revoking}
            accessibilityRole="button"
            style={({ pressed }) => [styles.revokeLinks, pressed && { opacity: 0.7 }]}
          >
            {revoking ? (
              <ActivityIndicator size="small" color={colors.danger} />
            ) : (
              <Text style={styles.revokeLinksText}>
                {t("personEdit.revokeLinks", { count: sharedLinkCount })}
              </Text>
            )}
          </Pressable>
        ) : null}
        {revokeResult ? (
          <Text style={styles.revokeDone} accessibilityLiveRegion="polite">
            {revokeResult}
          </Text>
        ) : null}

        {/* Remove person — the ONE place removal works for every contact.
            The home list's long-press remove only exists for people WITH
            tallies (zero-tally contacts never appear there), which left
            phone-book imports and typo-adds undeletable. Same archive
            semantics as home: relationship archived (entries kept as
            history), phone number freed for re-use. */}
        <Pressable
          onPress={() => setConfirmRemove(true)}
          disabled={busy}
          accessibilityRole="button"
          style={({ pressed }) => [styles.removeRow, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.removeRowText}>
            {t("common.remove.title", { name: [firstName, lastName].filter(Boolean).join(" ") })}
          </Text>
        </Pressable>
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
        visible={pickerVisible}
        selectedCode={countryCode}
        onSelect={(c) => setCountryCode(c)}
        onDismiss={() => setPickerVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  fillCenter: { flex: 1, alignItems: "center", justifyContent: "center" },
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
  body: { flex: 1, padding: 16, paddingTop: 24 },
  field: { marginBottom: 20 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  required: { color: colors.danger },
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
  // First + last name, side by side (matches the phone Contacts app).
  nameRow: { flexDirection: "row", gap: 10 },
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
  revokeLinks: {
    minHeight: 44,
    marginTop: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 8,
    backgroundColor: "rgba(220, 38, 38, 0.04)",
  },
  revokeLinksText: {
    fontSize: 14,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
  },
  revokeDone: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.textSubtle,
    marginTop: 8,
    textAlign: "center",
  },
  removeRow: {
    minHeight: 44,
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
