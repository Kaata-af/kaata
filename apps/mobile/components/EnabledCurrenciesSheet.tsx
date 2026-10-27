import { Ionicons } from "@expo/vector-icons";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Button } from "./Button";
import { SheetBackdrop } from "./SheetBackdrop";
import { SheetHandle } from "./SheetHandle";
import { SheetSurface } from "./SheetSurface";
import { useOverlayAnimation } from "../lib/use-overlay-animation";
import { useSheetDrag } from "../lib/use-sheet-drag";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";
import { rowDir, textDir } from "../lib/direction";
import { t } from "../lib/i18n";
import { icon } from "../lib/tokens";
import {
  SETTINGS_ROW_MIN_HEIGHT,
  SETTINGS_ROW_PADDING_X,
  SETTINGS_ROW_PADDING_Y,
  SETTINGS_SHEET_TOP_RADIUS,
} from "../lib/design-tokens";

/** A controlled draft: the parent persists only the explicit Save action. */
export function EnabledCurrenciesSheet(props: {
  visible: boolean;
  options: readonly { code: string; label: string; symbol: string }[];
  selected: readonly string[];
  defaultCurrency: string;
  onToggle: (code: string) => void;
  onSave: () => void;
  onDismiss: () => void;
  saving: boolean;
  conflicted?: boolean;
  error?: string | null;
  isRTL: boolean;
}) {
  const { rendered, opacity, position } = useOverlayAnimation(props.visible, 600);
  const dismiss = () => {
    if (!props.saving) props.onDismiss();
  };
  const drag = useSheetDrag(props.visible && !props.saving, position, dismiss);
  if (!rendered) return null;
  return (
    <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <SheetBackdrop onDismiss={dismiss} />
      </Animated.View>
      <Animated.View
        style={[styles.container, { transform: [{ translateY: drag.translateY }] }]}
        pointerEvents={props.visible ? "box-none" : "none"}
      >
        <SheetSurface {...drag.surfacePanHandlers} maxHeightRatio={0.82} style={styles.sheet}>
          <SheetHandle panHandlers={drag.panHandlers} onDismiss={dismiss} />
          <Text style={[styles.title, textDir(props.isRTL)]}>
            {t("vaultSettings.currencies.label")}
          </Text>
          <ScrollView
            {...drag.scrollProps}
            style={styles.choices}
            keyboardShouldPersistTaps="always"
            bounces={false}
          >
            {props.error ? (
              <Text style={[styles.error, textDir(props.isRTL)]} accessibilityRole="alert">
                {props.error}
              </Text>
            ) : null}
            <Text style={[styles.hint, textDir(props.isRTL)]}>
              {t("vaultSettings.currencies.hint")}
            </Text>
            {props.options.map((option) => {
              const checked = props.selected.includes(option.code);
              const isDefault = option.code === props.defaultCurrency;
              const disabled = props.saving || props.conflicted || isDefault;
              return (
                <Pressable
                  key={option.code}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`${option.code} ${option.label}`}
                  accessibilityState={{ checked, disabled: !!disabled }}
                  disabled={!!disabled}
                  onPress={() => {
                    if (!disabled) props.onToggle(option.code);
                  }}
                  style={[styles.choice, rowDir(props.isRTL)]}
                >
                  <Ionicons
                    name={checked ? "checkbox" : "square-outline"}
                    size={icon.row}
                    color={checked ? colors.actionPrimary : colors.textSubtle}
                  />
                  <Text style={styles.symbol}>{option.symbol}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.label, textDir(props.isRTL)]}>
                      {option.code} · {option.label}
                    </Text>
                    {isDefault ? (
                      <Text style={[styles.defaultHint, textDir(props.isRTL)]}>
                        {t("vaultSettings.currencies.default")}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.footer}>
            <View style={[styles.buttons, rowDir(props.isRTL)]}>
              <View style={styles.button}>
                <Button
                  label={t("common.cancel")}
                  variant="secondary"
                  fullWidth
                  disabled={props.saving}
                  onPress={dismiss}
                />
              </View>
              <View style={styles.button}>
                <Button
                  label={t("vaultSettings.name.save")}
                  fullWidth
                  loading={props.saving}
                  disabled={props.saving || props.conflicted || props.selected.length === 0}
                  onPress={() => {
                    if (!props.saving && !props.conflicted) props.onSave();
                  }}
                />
              </View>
            </View>
          </View>
        </SheetSurface>
      </Animated.View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  container: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopRightRadius: SETTINGS_SHEET_TOP_RADIUS,
    borderTopWidth: 1,
    borderTopColor: colors.borderDefault,
    minHeight: 0,
  },
  title: {
    fontFamily: fonts.sansSemi,
    fontSize: 17,
    color: colors.textEmphasis,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingTop: 8,
  },
  hint: {
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    color: colors.textSubtle,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingTop: 8,
    paddingBottom: 12,
  },
  choices: { flexShrink: 1, minHeight: 0 },
  choice: {
    minHeight: SETTINGS_ROW_MIN_HEIGHT,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingVertical: SETTINGS_ROW_PADDING_Y,
    alignItems: "center",
    gap: 12,
  },
  symbol: { minWidth: 28, fontFamily: fonts.sansSemi, fontSize: 18, color: colors.textEmphasis },
  label: { fontFamily: fonts.sansMedium, fontSize: 15, color: colors.textDefault },
  defaultHint: {
    fontFamily: fonts.sansRegular,
    fontSize: 12,
    color: colors.textSubtle,
    marginTop: 3,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    padding: 16,
  },
  buttons: { gap: 12 },
  button: { flex: 1 },
  error: {
    fontFamily: fonts.sansRegular,
    fontSize: 13,
    color: colors.danger,
    paddingHorizontal: SETTINGS_ROW_PADDING_X,
    paddingTop: 8,
    paddingBottom: 4,
  },
});
