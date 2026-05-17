import { StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";

export function EmptyState(props: { title: string; subtitle?: string }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{props.title}</Text>
      {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: 48, paddingHorizontal: 24, alignItems: "center" },
  title: { fontSize: 18, fontWeight: "600", color: colors.textPrimary, marginBottom: 4 },
  subtitle: { fontSize: 14, color: colors.textSecondary, textAlign: "center" },
});
