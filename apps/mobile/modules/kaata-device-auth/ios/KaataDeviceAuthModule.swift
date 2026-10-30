import ExpoModulesCore
import UIKit

/// Thin UI/lifecycle adapter; the standalone helper owns the protected read.
public class KaataDeviceAuthModule: Module {
  private let authenticator = DevicePasscodeAuthenticator()
  private var backgroundObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("KaataDeviceAuth")

    OnCreate {
      self.backgroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
      ) { [weak self] _ in self?.authenticator.cancelCurrent() }
    }

    OnDestroy {
      if let observer = self.backgroundObserver {
        NotificationCenter.default.removeObserver(observer)
        self.backgroundObserver = nil
      }
      self.authenticator.invalidate()
    }

    // This indicates presence of the native route, never a successful unlock.
    Function("supportsDevicePasscode") { true }

    AsyncFunction("authenticateWithDevicePasscode") {
      (requestId: String, reason: String, cancelLabel: String, promise: Promise) in
      guard UIApplication.shared.applicationState == .active else {
        promise.resolve(["success": false, "error": "app_cancel"])
        return
      }
      self.authenticator.authenticate(requestId: requestId, reason: reason, cancelLabel: cancelLabel) {
        result in promise.resolve(result.value)
      }
    }.runOnQueue(.main)

    AsyncFunction("cancelDevicePasscode") { (requestId: String) in
      self.authenticator.cancel(requestId: requestId)
    }.runOnQueue(.main)
  }
}
