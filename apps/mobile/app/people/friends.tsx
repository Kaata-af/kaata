import { Redirect } from "expo-router";

/** Keep old links working now that friends live directly on Home. */
export default function FriendsScreen() {
  return <Redirect href="/" />;
}
