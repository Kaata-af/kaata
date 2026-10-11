import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { passwordRules } from "../lib/account-rules";
import { colors } from "../lib/colors";
import { rowDir, textDir } from "../lib/direction";
import { fonts, sansLineHeight } from "../lib/fonts";
import { t } from "../lib/i18n";

type Key = Parameters<typeof t>[0];

// The new-password rules (docs/kaata-accounts.md §3), under every NEW password
// field. The ones this phone can judge are ticked as the user types; the last
// (common passwords, personal details) only the server checks, so it is never
// ticked. Monochrome on purpose: green and red mean money direction here.
export function PasswordRules({ value, isRTL }: { value: string; isRTL: boolean }) {
  const state = passwordRules(value);
  const rows: Array<[boolean, Key]> = [
    [state.length, "auth.password.rule.length"],
    [state.notOnlyDigits, "auth.password.rule.digits"],
    [state.noRuns, "auth.password.rule.runs"],
    [false, "auth.password.rule.personal"],
  ];
  return (
    <View style={styles.rules}>
      {rows.map(([met, key]) => (
        <View key={key} style={[styles.rule, rowDir(isRTL)]}>
          <Ionicons
            name={met ? "checkmark-circle" : "ellipse-outline"}
            size={14}
            color={met ? colors.textEmphasis : colors.textMuted}
          />
          <Text style={[styles.text, textDir(isRTL), met && styles.met]}>{t(key)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Tucked under the password field (FormField keeps 20 below itself).
  rules: { marginTop: -12, marginBottom: 16, gap: 4 },
  rule: { flexDirection: "row", alignItems: "center", gap: 6 },
  text: {
    flex: 1,
    fontSize: 12,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    lineHeight: sansLineHeight(12, 18),
  },
  met: { color: colors.textEmphasis },
});
