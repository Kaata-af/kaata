import type { TextInputInstance } from "react-native";
import { forwardRef, type ReactNode, useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, TextInput, type TextInputProps, View } from "react-native";
import { colors } from "../lib/colors";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { SETTINGS_DISABLED_OPACITY } from "../lib/design-tokens";
import { useSheetMotionPreference } from "./SheetBackdrop";

// Reusable form field that handles validation errors visibly — red border
// on the input, a small inline error message below it, and a brief shake
// animation when the error first appears. Replaces the previous pattern of
// firing a toast for field errors, which often went unseen because the
// soft keyboard covered the toast viewport.
//
// Pattern: parent component owns the error state (useState<string | null>),
// clears it on input change or before re-validating, and sets it on submit
// when validation fails. The shake fires automatically the first frame
// `error` flips from null/empty to a non-empty string.

export type FormFieldProps = TextInputProps & {
  label?: string;
  required?: boolean;
  error?: string | null;
  /**
   * A control inside the input's RIGHT edge (a password's show/hide), with room
   * kept for it. Physical right on purpose: the only fields that carry one are
   * LTR in both languages (see LTR_INPUT).
   */
  accessory?: ReactNode;
};

/**
 * Style for a field whose content is Latin by nature in either language: an
 * email address, a username, a password, an emailed code. Pass it as `style`
 * (FormField preserves the caller's layout styles), so a Dari UI does not mirror
 * what was typed or right-align the caret.
 */
export const LTR_INPUT = { writingDirection: "ltr", textAlign: "left" } as const;

export const FormField = forwardRef<TextInputInstance, FormFieldProps>(function FormField(
  { label, required, error, style, onChangeText, value, accessory, ...inputProps },
  ref,
) {
  const isRTL = useIsRTL();
  const reducedMotion = useSheetMotionPreference();
  const hasError = Boolean(error && error.length > 0);
  const disabled = inputProps.editable === false || inputProps.readOnly === true;

  // One-shot shake — runs on the rising edge of hasError. We track the
  // previous value with a ref so we only animate when error transitions
  // from "absent" to "present", not on every render that keeps the same
  // error string.
  const shake = useRef(new Animated.Value(0)).current;
  const prevHasError = useRef(hasError);
  useEffect(() => {
    let animation: Animated.CompositeAnimation | undefined;
    shake.setValue(0);
    if (!reducedMotion && hasError && !prevHasError.current) {
      animation = Animated.sequence([
        Animated.timing(shake, { toValue: -8, duration: 50, useNativeDriver: true }),
        Animated.timing(shake, { toValue: 8, duration: 60, useNativeDriver: true }),
        Animated.timing(shake, { toValue: -5, duration: 60, useNativeDriver: true }),
        Animated.timing(shake, { toValue: 5, duration: 60, useNativeDriver: true }),
        Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: true }),
      ]);
      animation.start();
    }
    prevHasError.current = hasError;
    return () => {
      animation?.stop();
    };
  }, [hasError, shake, reducedMotion]);

  return (
    <View style={styles.field}>
      {label ? (
        <Text style={[styles.label, textDir(isRTL), disabled && styles.labelDisabled]}>
          {label}
          {required ? (
            <Text style={[styles.required, disabled && styles.labelDisabled]}> *</Text>
          ) : null}
        </Text>
      ) : null}
      <Animated.View style={{ transform: [{ translateX: shake }] }}>
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          placeholderTextColor={colors.textMuted}
          // Associate the visible label with the input — without this,
          // TalkBack announces only the placeholder, which disappears as
          // soon as the user types. Callers can still override via
          // inputProps.
          accessibilityLabel={label}
          {...inputProps}
          accessibilityState={{ ...inputProps.accessibilityState, disabled }}
          style={[
            styles.input,
            textDir(isRTL),
            hasError && styles.inputError,
            accessory ? styles.inputWithAccessory : null,
            style,
            disabled && styles.inputDisabled,
          ]}
        />
        {accessory ? (
          <View
            style={[styles.accessory, disabled && styles.accessoryDisabled]}
            pointerEvents={disabled ? "none" : "auto"}
            accessibilityElementsHidden={disabled}
            importantForAccessibility={disabled ? "no-hide-descendants" : "auto"}
          >
            {accessory}
          </View>
        ) : null}
      </Animated.View>
      {hasError ? (
        <Text style={[styles.errorText, textDir(isRTL)]} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  field: { marginBottom: 20 },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
    marginBottom: 8,
  },
  required: { color: colors.danger },
  labelDisabled: { color: colors.textMuted },
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
  // Room for the accessory's 44px target at the right edge.
  inputWithAccessory: { paddingRight: 48 },
  inputDisabled: {
    color: colors.textMuted,
    backgroundColor: colors.bgMuted,
    borderColor: colors.borderSubtle,
  },
  accessoryDisabled: { opacity: SETTINGS_DISABLED_OPACITY },
  accessory: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    justifyContent: "center",
  },
  inputError: {
    borderColor: colors.danger,
    // Subtle red wash so the border isn't doing all the work. Same chroma
    // as the chip pastels — fits the design system.
    backgroundColor: "rgba(220, 38, 38, 0.04)",
  },
  errorText: {
    fontSize: 12,
    fontFamily: fonts.sansMedium,
    color: colors.danger,
    marginTop: 6,
  },
});
