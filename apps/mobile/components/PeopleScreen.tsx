import type { PropsWithChildren } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../lib/colors";

export function PeopleScreen({ children }: PropsWithChildren) {
  const { top, bottom, left, right } = useSafeAreaInsets();

  // iOS presents these routes in a separate native view hierarchy. Use the
  // app's insets from React context so the header clears the status bar on entry.
  if (Platform.OS === "ios") {
    return (
      <View
        style={[
          styles.screen,
          { paddingTop: top, paddingBottom: bottom, paddingLeft: left, paddingRight: right },
        ]}
      >
        {children}
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.bgDefault } });
