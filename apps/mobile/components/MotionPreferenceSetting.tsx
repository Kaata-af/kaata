import { useEffect, useRef, useState } from "react";
import { useIsFocused } from "expo-router";
import { useIsRTL } from "../lib/direction";
import { t } from "../lib/i18n";
import { useMotionPreference, type MotionMode } from "../lib/motion-preference";
import { OptionSheet } from "./OptionSheet";
import { NavRow } from "./SettingsScreen";
import { useToast } from "./Toast";

const MODES = ["auto", "full", "reduced"] as const;

/** A device preference, available to every role and while signed out. */
export function MotionPreferenceSetting() {
  const isRTL = useIsRTL();
  const focused = useIsFocused();
  const toast = useToast();
  const { mode, initialized, setMode } = useMotionPreference();
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const open = useRef(false);
  const presentation = useRef(0);
  const version = presentation.current;
  const latest = useRef({ mode, initialized, setMode, toast, focused });
  latest.current = { mode, initialized, setMode, toast, focused };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      open.current = false;
      presentation.current++;
    };
  }, []);
  useEffect(() => {
    if (!focused) {
      open.current = false;
      presentation.current++;
      setVisible(false);
    }
  }, [focused]);

  const dismiss = () => {
    if (!mounted.current || presentation.current !== version) return;
    open.current = false;
    setVisible(false);
  };
  const choose = (value: string) => {
    if (
      !mounted.current ||
      !open.current ||
      presentation.current !== version ||
      savingRef.current ||
      !latest.current.focused ||
      !latest.current.initialized ||
      !MODES.some((mode) => mode === value)
    )
      return;
    open.current = false;
    setVisible(false);
    if (value === latest.current.mode) return;
    savingRef.current = true;
    setSaving(true);
    void latest.current
      .setMode(value as MotionMode)
      .catch(() => {
        if (mounted.current && latest.current.focused)
          latest.current.toast.push(t("settings.motion.saveFailed"), "error");
      })
      .finally(() => {
        savingRef.current = false;
        if (mounted.current) setSaving(false);
      });
  };

  return (
    <>
      <NavRow
        icon="speedometer-outline"
        label={t("settings.motion.label")}
        hint={t("settings.motion.hint")}
        trailing={t(`settings.motion.option.${mode}`)}
        disabled={!initialized || saving || !focused}
        onPress={() => {
          if (
            !mounted.current ||
            !latest.current.initialized ||
            !latest.current.focused ||
            savingRef.current
          )
            return;
          presentation.current++;
          open.current = true;
          setVisible(true);
        }}
        isRTL={isRTL}
      />
      <OptionSheet
        visible={visible}
        title={t("settings.motion.label")}
        options={MODES.map((mode) => ({
          key: mode,
          label: t(`settings.motion.option.${mode}`),
          hint: t(`settings.motion.option.${mode}.hint`),
        }))}
        selected={mode}
        onSelect={choose}
        onDismiss={dismiss}
        isRTL={isRTL}
      />
    </>
  );
}
