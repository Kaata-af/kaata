import ExpoModulesCore
import ExpoNotifications
import UIKit
import UserNotifications

// Expo's iOS response emitter completes the OS callback before async JS work.
// Preserve the user's tap before JS boots, and grant bounded execution time.
// No network credentials or ledger data are stored here; only opaque IDs.
private final class ReviewHandoff: NSObject, NotificationDelegate {
  static let shared = ReviewHandoff()
  private let key = "kaata.pendingNotificationReviews"
  private var task: UIBackgroundTaskIdentifier = .invalid
  private var registered = false

  func register() {
    guard !registered else { return }
    registered = true
    NotificationCenterManager.shared.addDelegate(self)
  }

  func pending() -> [[String: Any]] {
    UserDefaults.standard.array(forKey: key) as? [[String: Any]] ?? []
  }

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    guard ["tab-accept", "tab-reject"].contains(response.actionIdentifier) else { return false }
    if Thread.isMainThread { capture(response) }
    else { DispatchQueue.main.sync { self.capture(response) } }
    return false // Expo owns the response event and completion callback.
  }

  private func capture(_ response: UNNotificationResponse) {
    let content = response.notification.request.content
    guard let data = (content.userInfo["body"] as? [String: Any]) ?? (content.userInfo as? [String: Any]),
          let tab = data["tab_id"] as? String, UUID(uuidString: tab) != nil,
          let entry = data["entry_id"] as? String, UUID(uuidString: entry) != nil,
          let rev = data["rev"] as? NSNumber,
          let role = data["role"] as? String, ["a", "b"].contains(role),
          data["kind"] as? String == "entry_created" else { return }
    let id = response.notification.request.identifier
    var rows = pending()
    if !rows.contains(where: { $0["id"] as? String == id }) {
      rows.append(["id": id, "action": response.actionIdentifier,
                   "data": ["tab_id": tab, "entry_id": entry, "rev": rev,
                            "role": role, "kind": "entry_created"]])
      UserDefaults.standard.set(rows, forKey: key)
    }
    if task == .invalid {
      task = UIApplication.shared.beginBackgroundTask(withName: "KaataReview") { [weak self] in self?.end() }
    }
  }

  func complete(_ id: String) {
    let rows = pending().filter { $0["id"] as? String != id }
    UserDefaults.standard.set(rows, forKey: key)
    if rows.isEmpty { end() }
  }

  private func end() {
    guard task != .invalid else { return }
    let current = task
    task = .invalid
    UIApplication.shared.endBackgroundTask(current)
  }
}

public class KaataNotificationActionsSubscriber: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication,
                          didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    ReviewHandoff.shared.register()
    return true
  }
}

public class KaataNotificationActionsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KaataNotificationActions")
    AsyncFunction("pending") { () -> [[String: Any]] in
      ReviewHandoff.shared.register()
      return ReviewHandoff.shared.pending()
    }.runOnQueue(.main)
    AsyncFunction("complete") { (id: String) in ReviewHandoff.shared.complete(id) }.runOnQueue(.main)
  }
}
