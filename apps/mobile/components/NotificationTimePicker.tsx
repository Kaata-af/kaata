import DateTimePicker from "@react-native-community/datetimepicker";
import { useEffect, useState } from "react";
import { Animated, Modal, Platform, StyleSheet, Text } from "react-native";
import { Button } from "./Button";
import { SheetBackdrop } from "./SheetBackdrop";
import { SheetHandle } from "./SheetHandle";
import { SheetSurface } from "./SheetSurface";
import { useOverlayAnimation } from "../lib/use-overlay-animation";
import { useSheetDrag } from "../lib/use-sheet-drag";
import { colors } from "../lib/colors";
import { textDir, useIsRTL } from "../lib/direction";
import { fonts } from "../lib/fonts";
import { t } from "../lib/i18n";

type Props = {
  visible: boolean;
  title: string;
  minute: number;
  onSelect: (minute: number) => void;
  onDismiss: () => void;
};
const timeDate = (minute: number) => new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60);

function IosTimePicker(props: Props) {
  const rtl = useIsRTL();
  const [draft, setDraft] = useState(() => timeDate(props.minute));
  useEffect(() => {
    if (props.visible) setDraft(timeDate(props.minute));
  }, [props.visible, props.minute]);
  const { rendered, opacity, position } = useOverlayAnimation(props.visible, 600);
  const drag = useSheetDrag(props.visible, position, props.onDismiss);
  if (!rendered) return null;
  return (
    <Modal visible transparent animationType="none" onRequestClose={props.onDismiss}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]}>
        <SheetBackdrop onDismiss={drag.dismiss} />
      </Animated.View>
      <Animated.View
        style={[styles.position, { transform: [{ translateY: drag.translateY }] }]}
        pointerEvents={props.visible ? "box-none" : "none"}
      >
        {/* The native wheels own vertical gestures; only the handle drags the sheet. */}
        <SheetSurface style={styles.sheet} maxHeightRatio={0.7}>
          <SheetHandle panHandlers={drag.panHandlers} onDismiss={drag.dismiss} />
          <Text style={[styles.title, textDir(rtl)]}>{props.title}</Text>
          <DateTimePicker
            value={draft}
            mode="time"
            display="spinner"
            locale="en-GB"
            themeVariant="light"
            textColor={colors.textEmphasis}
            onChange={(_event, date) => {
              if (date) setDraft(date);
            }}
          />
          <Button
            label={t("common.done")}
            fullWidth
            onPress={() => {
              if (props.visible) props.onSelect(draft.getHours() * 60 + draft.getMinutes());
            }}
          />
        </SheetSurface>
      </Animated.View>
    </Modal>
  );
}

export function NotificationTimePicker(props: Props) {
  if (Platform.OS === "ios") return <IosTimePicker {...props} />;
  return props.visible ? (
    <DateTimePicker
      value={timeDate(props.minute)}
      mode="time"
      is24Hour
      onChange={(event, date) => {
        if (event.type === "set" && date) props.onSelect(date.getHours() * 60 + date.getMinutes());
        else props.onDismiss();
      }}
    />
  ) : null;
}
const styles = StyleSheet.create({
  position: { position: "absolute", bottom: 0, left: 0, right: 0 },
  sheet: {
    backgroundColor: colors.bgDefault,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  title: { fontFamily: fonts.sansSemi, fontSize: 16, color: colors.textEmphasis, marginTop: 4 },
});
