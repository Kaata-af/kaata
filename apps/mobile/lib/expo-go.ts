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
// a NO-OP in installed builds, where the ExpoGo native module is absent.
//
// Match Expo's isRunningInExpoGo check. SDK 58 no longer reliably reports
// storeClient through Constants. Use the optional lookup so installed builds
// do not throw, and keep Expo's root barrel out of early bootstrap imports.
import { requireOptionalNativeModule } from "expo-modules-core";

export const IS_EXPO_GO = requireOptionalNativeModule("ExpoGo") !== null;
