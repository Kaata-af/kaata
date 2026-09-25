import { AuthScreen } from "./onboarding/auth";

/** Authentication for an existing action, without the offline onboarding path. */
export default function RedirectSignInScreen() {
  return <AuthScreen redirected />;
}
