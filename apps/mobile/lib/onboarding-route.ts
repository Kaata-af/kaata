export type OnboardingStep = "language" | "calendar" | "auth" | "profile" | "kaata" | "done";

export function parseOnboardingStep(raw: string | null): OnboardingStep | null {
  return raw === "language" ||
    raw === "calendar" ||
    raw === "auth" ||
    raw === "profile" ||
    raw === "kaata" ||
    raw === "done"
    ? raw
    : null;
}

/** Resume existing setup/restore before applying the fresh-install sequence. */
export function pickInitialRoute(args: {
  hasOnboarded: boolean;
  onboardingStep: OnboardingStep | null;
  deviceIsPersian: boolean;
  accountId: string | null;
  restoreSkipped: boolean;
}): string {
  if (args.hasOnboarded) return "index";
  // The restore gate remains between authentication and profile. A calendar
  // choice is a device preference, so returning to it never clears identity
  // or the pending invitation/restore intent.
  if (
    args.accountId &&
    !args.restoreSkipped &&
    (args.onboardingStep === "profile" || args.onboardingStep === "auth")
  ) {
    return "onboarding/restore";
  }
  if (args.onboardingStep === "auth") return "onboarding/auth";
  if (args.onboardingStep === "profile") return "onboarding/profile";
  if (args.onboardingStep === "kaata") return "onboarding/kaata";
  if (args.onboardingStep === "calendar") return "onboarding/calendar";
  if (args.onboardingStep === "language") return "onboarding/language";
  // A stale 'done' without a self row is still a fresh setup. Persian devices
  // already have the right language, but everyone gets to choose their dates.
  return args.deviceIsPersian ? "onboarding/calendar" : "onboarding/language";
}
