import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";

export type TabItem<K extends string = string> = {
  key: K;
  label: string;
};

// Pill segmented control. Active tab is black-filled with white text; inactive
// is transparent text on a hairline-bordered container background.
export function Tabs<K extends string>(props: {
  tabs: ReadonlyArray<TabItem<K>>;
  value: K;
  onChange: (key: K) => void;
}) {
  return (
    <View style={styles.container}>
      {props.tabs.map((t) => {
        const active = t.key === props.value;
        return (
          <Pressable
            key={t.key}
            onPress={() => props.onChange(t.key)}
            // Selection was color-only — TalkBack users couldn't tell which
            // tab is active, and this control is also the only non-gesture
            // alternative to the home swipe rail.
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => [
              styles.tab,
              active && styles.tabActive,
              pressed && !active && { backgroundColor: colors.bgSubtle },
            ]}
          >
            <Text style={[styles.label, active && styles.labelActive]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    padding: 4,
    backgroundColor: colors.bgMuted,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.borderDefault,
  },
  tab: {
    flex: 1,
    // L40: this is the designated non-gesture alternative to the home swipe
    // rail (the primary To-collect/To-pay switch for switch-access / motor-
    // impaired / TalkBack users), so it must meet the 44/48dp touch-target
    // floor — paddingVertical 8 around a 13px label left it ~34dp tall.
    minHeight: 44,
    paddingVertical: 8,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  tabActive: {
    backgroundColor: colors.bgInverted,
  },
  label: {
    fontSize: 13,
    fontFamily: fonts.sansMedium,
    color: colors.textDefault,
  },
  labelActive: {
    color: colors.textInverted,
    fontFamily: fonts.sansSemi,
  },
});
