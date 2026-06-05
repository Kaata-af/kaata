import { forwardRef, useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, TextInput, type TextInputProps, View } from "react-native";
import { colors } from "../lib/colors";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";

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
};

export const FormField = forwardRef<TextInput, FormFieldProps>(function FormField(
  { label, required, error, style, onChangeText, value, ...inputProps },
  ref,
) {
  const isRTL = useIsRTL();
  const hasError = Boolean(error && error.length > 0);

  // One-shot shake — runs on the rising edge of hasError. We track the
  // previous value with a ref so we only animate when error transitions
  // from "absent" to "present", not on every render that keeps the same
  // error string.
  const shake = useRef(new Animated.Value(0)).current;
  const prevHasError = useRef(hasError);
  useEffect(() => {
    if (hasError && !prevHasError.current) {
      shake.setValue(0);
      Animated.sequence([
        Animated.timing(shake, { toValue: -8, duration: 50, useNativeDriver: true }),
        Animated.timing(shake, { toValue: 8, duration: 60, useNativeDriver: true }),
        Animated.timing(shake, { toValue: -5, duration: 60, useNativeDriver: true }),
        Animated.timing(shake, { toValue: 5, duration: 60, useNativeDriver: true }),
        Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: true }),
      ]).start();
    }
    prevHasError.current = hasError;
  }, [hasError, shake]);

  return (
    <View style={styles.field}>
      {label ? (
        <Text style={[styles.label, textDir(isRTL)]}>
          {label}
          {required ? <Text style={styles.required}> *</Text> : null}
        </Text>
      ) : null}
      <Animated.View style={{ transform: [{ translateX: shake }] }}>
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          placeholderTextColor={colors.textMuted}
          {...inputProps}
          style={[styles.input, textDir(isRTL), hasError && styles.inputError, style]}
        />
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
