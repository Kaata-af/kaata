import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { colors } from "../lib/colors";
import { textDir } from "../lib/direction";
import { t } from "../lib/i18n";
import { reminderNotificationStatus } from "../lib/reminder-notifications";
import { radius, typography } from "../lib/tokens";

/** With notifications off, reminders still work but only inside Kaata. That
 * used to be one brief toast at save time; this stays on the reminder screens
 * until the permission is back. Never prompts: it only reads the status on
 * focus and on return from Settings. */
export function ReminderPermissionNotice({ isRTL }: { isRTL: boolean }) {
  const [denied, setDenied] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const check = useCallback(() => {
    void reminderNotificationStatus()
      .then((status) => {
        if (mounted.current) setDenied(status === "denied");
      })
      .catch(() => {});
  }, []);
  useFocusEffect(
    useCallback(() => {
      check();
      const app = AppState.addEventListener("change", (state) => {
        if (state === "active") check();
      });
      return () => app.remove();
    }, [check]),
  );
  if (!denied) return null;
  return (
    <View style={styles.card}>
      <Text style={[styles.body, textDir(isRTL)]}>{t("reminders.notificationsOff")}</Text>
      <View style={styles.action}>
        <Button
          variant="secondary"
          label={t("contacts.permission.button")}
          onPress={() => void Linking.openSettings().catch(() => {})}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    backgroundColor: colors.bgMuted,
  },
  body: { ...typography.bodySm, color: colors.textDefault },
  action: { marginTop: 12 },
});
