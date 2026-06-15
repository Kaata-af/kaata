// Sheet/dialog backdrop blur policy, in ONE place.
//
// "dimezisBlurView" is the real Android Gaussian blur (the frosted-glass
// backdrop behind every sheet/dialog). It was briefly switched to "none" for
// animation perf, but "none" makes expo-blur paint a flat pale near-white wash
// instead of a blur, which read as a washed-out overlay over sheets and the
// onboarding country picker. Restored to the real blur (the look we want); if a
// specific low-end device janks through the 220ms entrance, revisit per-device
// rather than globally disabling.
//
// iOS ignores experimentalBlurMethod entirely (native blur), so this only
// affects Android.
export const SHEET_BLUR_METHOD: "none" | "dimezisBlurView" = "dimezisBlurView";
