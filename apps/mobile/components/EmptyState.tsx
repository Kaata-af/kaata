import { StyleSheet, Text, View } from "react-native";
import { colors } from "../lib/colors";
import { fonts } from "../lib/fonts";

export function EmptyState(props: { title: string; subtitle?: string }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{props.title}</Text>
      {props.subtitle ? <Text style={styles.subtitle}>{props.subtitle}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: 56, paddingHorizontal: 24, alignItems: "center" },
  title: {
    fontSize: 15,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: fonts.sansRegular,
    color: colors.textSubtle,
    textAlign: "center",
    lineHeight: 19,
  },
});
