// apps/mobile/lib/expo-go.ts
//
// Single source of truth for "are we running inside the Expo Go sandbox?"
//
// Expo Go ships a fixed set of native modules and does NOT include our custom
// ones (notifee, modules/kaata-bt-classic, etc.). require()-ing such a module
// in Expo Go throws at module-LOAD time (e.g. notifee's NotifeeNativeModule
// getter throws "Notifee native module not found."). A try/catch swallows it
// for control flow, but React Native's dev LogBox still surfaces the thrown
// error as a red banner the developer has to dismiss on every launch.
//
// Gating the require on this flag avoids the throw entirely in Expo Go and is
// a NO-OP in every real build: dev-client / preview / production all report
// executionEnvironment "standalone" (or "bare"), so IS_EXPO_GO is false and
// the native module loads exactly as before.
//
// This is a leaf module (only depends on expo-constants, a core native module
// that is always linked and safe to evaluate at the very top of the bundle).
import Constants from "expo-constants";

export const IS_EXPO_GO = Constants.executionEnvironment === "storeClient";
