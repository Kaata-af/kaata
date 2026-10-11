import { Ionicons } from "@expo/vector-icons";
import { forwardRef, useState } from "react";
import { Pressable, StyleSheet, type TextInput } from "react-native";
import { colors } from "../lib/colors";
import { t } from "../lib/i18n";
import { TOUCH_MIN } from "../lib/tokens";
import { FormField, type FormFieldProps, LTR_INPUT } from "./FormField";

// A FormField for a password, with the show/hide toggle every password field
// carries (docs/kaata-accounts.md §7): a shopkeeper typing on a small phone, in
// a script that is not their keyboard's, needs to see what they typed before a
// mistyped password costs a code or an attempt. Hidden again on every mount.
//
// Always LTR (LTR_INPUT): the characters must sit in the same order in both
// languages. Autocorrect and capitalization are off, because both silently
// change a password.
export type PasswordFieldProps = Omit<FormFieldProps, "secureTextEntry" | "accessory">;

export const PasswordField = forwardRef<TextInput, PasswordFieldProps>(function PasswordField(
  { style, ...props },
  ref,
) {
  const [shown, setShown] = useState(false);
  const toggleLabel = t(shown ? "auth.password.hide" : "auth.password.show");
  return (
    <FormField
      ref={ref}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      {...props}
      secureTextEntry={!shown}
      style={[LTR_INPUT, style]}
      accessory={
        <Pressable
          onPress={() => setShown((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={toggleLabel}
          style={({ pressed }) => [styles.toggle, pressed && { opacity: 0.6 }]}
        >
          <Ionicons
            name={shown ? "eye-off-outline" : "eye-outline"}
            size={20}
            color={colors.textSubtle}
          />
        </Pressable>
      }
    />
  );
});

const styles = StyleSheet.create({
  toggle: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    alignItems: "center",
    justifyContent: "center",
  },
});
