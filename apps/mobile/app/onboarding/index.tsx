import { Redirect } from "expo-router";

// `/onboarding` (no trailing path) used to be the single-step name form.
// Now it's a directory of {language, auth, profile, index} screens.
// Keep this index stub so anyone (deep links, hard-coded references,
// future Settings "Re-do setup" affordance) hitting `/onboarding` lands
// on a real screen instead of an ambiguous 404.

export default function OnboardingIndex() {
  return <Redirect href="/onboarding/language" />;
}
