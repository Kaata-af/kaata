// Static security contracts complement (not replace) Apple SDK compilation and
// an installed-iOS passcode test. Never exercises a real prompt or Keychain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../modules/kaata-device-auth");
const helper = readFileSync(resolve(root, "ios/DevicePasscodeAuthenticator.swift"), "utf8");
const adapter = readFileSync(resolve(root, "ios/KaataDeviceAuthModule.swift"), "utf8");
const config = JSON.parse(readFileSync(resolve(root, "expo-module.config.json"), "utf8"));
const podspec = readFileSync(resolve(root, "ios/KaataDeviceAuth.podspec"), "utf8");
assert.deepEqual(config.platforms, ["ios"]);
assert.deepEqual(config.ios.modules, ["KaataDeviceAuthModule"]);
for (const imported of [...helper.matchAll(/^import (\w+)$/gm)].map((match) => match[1]))
  assert.ok(
    ["Foundation", "LocalAuthentication", "Security"].includes(imported),
    "Helper must typecheck against the Apple SDK without Expo/Pods",
  );
assert.ok(podspec.includes("'16.4'"));
assert.ok(podspec.includes("'5.9'"));
assert.ok(helper.includes("kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly"));
assert.ok(
  helper.includes(".devicePasscode, &accessError"),
  "Passcode constraint, not biometric-or-passcode userPresence",
);
assert.ok(!helper.includes(".userPresence"));
assert.ok(!helper.includes(".biometryAny"));
assert.ok(!helper.includes(".biometryCurrentSet"));
assert.ok(
  !helper.includes("evaluatePolicy("),
  "A second Face ID policy request cannot substitute for the protected passcode read",
);
assert.ok(helper.includes("SecRandomCopyBytes(kSecRandomDefault"));
assert.ok(helper.includes("let account = UUID().uuidString"));
assert.ok(helper.includes("kSecAttrService as String: service"));
assert.ok(helper.includes("kSecAttrSynchronizable as String: false"));
assert.ok(helper.includes("defer { SecItemDelete(cleanup as CFDictionary) }"));
assert.ok(helper.includes("noninteractive.interactionNotAllowed = true"));
assert.ok(helper.includes("insertion[kSecUseAuthenticationContext as String] = noninteractive"));
assert.ok(helper.includes("cleanup[kSecUseAuthenticationContext as String] = noninteractive"));
assert.ok(helper.includes("query[kSecUseAuthenticationContext as String] = request.context"));
assert.ok(helper.includes("defer { accessError?.release() }"));
assert.ok(helper.includes("let staleStatus = SecItemDelete(stale as CFDictionary)"));
assert.ok(
  helper.includes('guard self.active == nil else { completion(.failed("app_cancel")); return }'),
);
assert.ok(
  helper.includes("request.id == requestId"),
  "Cancellation must identify its own native request",
);
const read = helper.indexOf("let status = SecItemCopyMatching");
const match = helper.indexOf("guard let data = received as? Data, data == expected");
const success = helper.lastIndexOf("return .authenticated");
assert.ok(read > helper.indexOf("guard SecItemAdd("));
assert.ok(
  match > read && success > match,
  "Only a successful protected read of the expected random sentinel authenticates",
);
assert.ok(helper.slice(read, success).includes("guard !request.isCancelled"));
assert.ok(
  helper.includes('request.isCancelled || self.destroyed ? .failed("app_cancel") : result'),
);
assert.ok(adapter.includes("UIApplication.shared.applicationState == .active"));
assert.ok(adapter.includes("UIApplication.didEnterBackgroundNotification"));
assert.ok(adapter.includes("OnDestroy"));
assert.ok(adapter.includes("self.authenticator.invalidate()"));
assert.ok(adapter.includes(".runOnQueue(.main)"));
assert.ok(!helper.includes("UserDefaults") && !helper.includes("SecureStore" + "."));
console.log(
  "PASS native device-passcode contracts: isolated iOS module, public passcode ACL, device-only ephemeral nonce, protected-read-only success, scoped cancellation and foreground/background/destruction guards; Apple SDK/device validation remains separate",
);
