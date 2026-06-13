// kaata://pair/<token> deep-link handler — RETIRED (M4).
//
// This screen used to run the legacy SERVER pair-join: it INSERTed an
// anchor-less vault row, called POST /v1/vaults/:vault_id/credential to
// mint a VMC, and cached it. M4 retired the VMC trust system — the
// membership chain is now the sole trust path and every join is
// chain-native: the joiner must PIN the owner's trust anchor (from the QR)
// and complete a BLE handshake where it presents the QR's shop_mode_token
// as the mesh pair_nonce, and the OWNER emits the admission events. A
// remote deep link can't carry that BLE rendezvous (it requires physical
// proximity), so deep-link joining is no longer supported.
//
// The route is kept so any in-flight shared links land on a clear message
// instead of a blank screen; the user is told to scan the QR in person.

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "../../components/Button";
import { colors } from "../../lib/colors";
import { textDir, useIsRTL } from "../../lib/direction";
import { fonts } from "../../lib/fonts";
import { t } from "../../lib/i18n";

export default function PairDeepLinkScreen() {
  const router = useRouter();
  const isRTL = useIsRTL();

  function onDone() {
    router.replace("/");
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.body}>
        <View style={styles.fillCenter}>
          <Ionicons name="qr-code-outline" size={48} color={colors.textMuted} />
          <View style={{ height: 16 }} />
          <Text style={[styles.heading, textDir(isRTL)]}>{t("pairLink.unsupported.title")}</Text>
          <Text style={[styles.body2, textDir(isRTL)]}>{t("pairLink.unsupported.body")}</Text>
          <View style={{ height: 24 }} />
          <Button label={t("common.backToKaata")} onPress={onDone} />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgDefault },
  body: { flex: 1, padding: 24 },
  fillCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  heading: {
    fontSize: 20,
    fontFamily: fonts.sansSemi,
    color: colors.textEmphasis,
    textAlign: "center",
  },
  body2: {
    fontSize: 14,
    fontFamily: fonts.sansRegular,
    color: colors.textDefault,
    textAlign: "center",
    lineHeight: 20,
    marginTop: 8,
  },
});
