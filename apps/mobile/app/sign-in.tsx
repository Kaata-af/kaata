import { useLocalSearchParams } from "expo-router";
import { AuthScreen } from "./onboarding/auth";

/** Authentication for an existing action, without the offline onboarding path.
 * Settings opens the provider choices; `?mode=email` still opens straight on
 * the email flow, including a code step resumed after a cold launch. */
export default function RedirectSignInScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  return <AuthScreen redirected initialMode={mode === "email" ? "email" : "providers"} />;
}
