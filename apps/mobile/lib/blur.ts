import { Platform } from "react-native";

// Sheet/dialog backdrop blur policy, in ONE place.
//
// "dimezisBlurView" is a real Android blur that re-snapshots and blurs the
// view hierarchy every frame — it visibly drops frames through the 220ms
// sheet/dialog entrance/exit animations on the low-end Mali/PowerVR GPUs
// our audience actually owns. "none" makes expo-blur fall back to a plain
// translucent overlay, which the opaque tint layer every sheet already
// stacks on top approximates anyway.
//
// iOS ignores experimentalBlurMethod entirely (it has native blur), so the
// value only matters on Android. Flip this constant back to
// "dimezisBlurView" if we ever decide the look is worth the jank.
export const SHEET_BLUR_METHOD: "none" | "dimezisBlurView" =
  Platform.OS === "android" ? "none" : "dimezisBlurView";
