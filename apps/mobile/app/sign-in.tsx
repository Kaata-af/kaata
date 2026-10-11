import { useLocalSearchParams } from "expo-router";
import { AuthScreen } from "./onboarding/auth";

/** Authentication for an existing action, without the offline onboarding path.
 * `?mode=email` opens straight on the email flow (the profile sheet's "Sign in
 * with email" row). */
export default function RedirectSignInScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  return <AuthScreen redirected initialMode={mode === "email" ? "email" : "providers"} />;
}
