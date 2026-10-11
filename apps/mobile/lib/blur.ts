// Expo 57 requires both a BlurTargetView ref and an Android blur method.
// Android 12+ uses RenderNode; older phones get our dim scrim instead of an
// expensive RenderScript animation. iOS uses its own native blur.
export const SHEET_BLUR_METHOD = "dimezisBlurViewSdk31Plus" as const;
