import Foundation
import LocalAuthentication
import Security

/// Owns only ephemeral, random Keychain sentinels. It never receives, stores,
/// compares, or returns the phone passcode, and never reads Kaata ledger data.
final class DevicePasscodeAuthenticator: @unchecked Sendable {
  struct Result: Sendable {
    let success: Bool
    let error: String?

    static let authenticated = Result(success: true, error: nil)
    static func failed(_ error: String) -> Result { Result(success: false, error: error) }
    var value: [String: Any] {
      if success { return ["success": true] }
      return ["success": false, "error": error ?? "not_available"]
    }
  }

  private final class Request: @unchecked Sendable {
    let id: String
    let context = LAContext()
    let completion: (Result) -> Void
    private let lock = NSLock()
    private var cancelled = false

    init(id: String, completion: @escaping (Result) -> Void) {
      self.id = id
      self.completion = completion
    }

    var isCancelled: Bool {
      lock.lock()
      defer { lock.unlock() }
      return cancelled
    }

    func cancel() {
      lock.lock()
      cancelled = true
      lock.unlock()
      context.invalidate()
    }
  }

  private let state = DispatchQueue(label: "af.kaata.device-passcode.state")
  private let work = DispatchQueue(label: "af.kaata.device-passcode.keychain", qos: .userInitiated)
  // This service is exclusively owned by this module. Cleanup must never use
  // a broad Keychain query or touch SecureStore, other services, or access groups.
  private let service = "\(Bundle.main.bundleIdentifier ?? "af.kaata.app").kaata.device-passcode.sentinel.v1"
  private var active: Request?
  private var destroyed = false

  func authenticate(requestId: String, reason: String, cancelLabel: String,
                    completion: @escaping (Result) -> Void) {
    state.async {
      guard !self.destroyed else { completion(.failed("app_cancel")); return }
      guard !requestId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            requestId.utf16.count <= 128,
            !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            reason.utf16.count <= 2048, cancelLabel.utf16.count <= 256 else {
        completion(.failed("invalid_context"))
        return
      }
      guard self.active == nil else { completion(.failed("app_cancel")); return }
      let request = Request(id: requestId, completion: completion)
      request.context.localizedReason = reason
      if !cancelLabel.isEmpty { request.context.localizedCancelTitle = cancelLabel }
      request.context.interactionNotAllowed = false
      request.context.touchIDAuthenticationAllowableReuseDuration = 0
      self.active = request
      self.work.async {
        let result = self.perform(request)
        self.state.async {
          guard self.active === request else { return }
          self.active = nil
          request.context.invalidate()
          request.completion(request.isCancelled || self.destroyed ? .failed("app_cancel") : result)
        }
      }
    }
  }

  func cancel(requestId: String) {
    state.async {
      guard let request = self.active, request.id == requestId else { return }
      request.cancel()
      // Keep the slot until the protected read returns and its item is deleted.
    }
  }

  func cancelCurrent() {
    state.async { self.active?.cancel() }
  }

  func invalidate() {
    state.async {
      self.destroyed = true
      self.active?.cancel()
    }
  }

  private func perform(_ request: Request) -> Result {
    guard !request.isCancelled else { return .failed("app_cancel") }
    var policyError: NSError?
    guard request.context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
      return .failed(errorCode(policyError))
    }
    // Creation and deletion must never display authentication UI. A separate
    // context avoids the deprecated kSecUseAuthenticationUI flags and cannot
    // contribute a cached approval to the later interactive protected read.
    let noninteractive = LAContext()
    noninteractive.interactionNotAllowed = true
    defer { noninteractive.invalidate() }
    // An interrupted process may leave a sentinel. No active request can be
    // using this service: the state queue serializes requests until cleanup.
    let stale: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrSynchronizable as String: false,
      kSecUseAuthenticationContext as String: noninteractive,
    ]
    let staleStatus = SecItemDelete(stale as CFDictionary)
    guard staleStatus == errSecSuccess || staleStatus == errSecItemNotFound else {
      return .failed("not_available")
    }
    guard !request.isCancelled else { return .failed("app_cancel") }

    var expected = Data(count: 32)
    let randomStatus = expected.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) -> OSStatus in
      guard let address = buffer.baseAddress else { return errSecParam }
      return SecRandomCopyBytes(kSecRandomDefault, buffer.count, address)
    }
    guard randomStatus == errSecSuccess else { return .failed("not_available") }
    var accessError: Unmanaged<CFError>?
    defer { accessError?.release() }
    guard let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
      .devicePasscode, &accessError
    ) else { return .failed("not_available") }
    let account = UUID().uuidString
    let item: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: false,
    ]
    var cleanup = item
    cleanup[kSecUseAuthenticationContext as String] = noninteractive
    defer { SecItemDelete(cleanup as CFDictionary) }
    var insertion = item
    insertion[kSecUseAuthenticationContext as String] = noninteractive
    insertion[kSecAttrAccessControl as String] = access
    insertion[kSecValueData as String] = expected
    // Creation is NOT authentication. Only the subsequent protected read can
    // succeed, and that read must satisfy the devicePasscode constraint.
    guard SecItemAdd(insertion as CFDictionary, nil) == errSecSuccess else {
      return .failed("not_available")
    }
    guard !request.isCancelled else { return .failed("app_cancel") }
    var query = item
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecUseAuthenticationContext as String] = request.context
    var received: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &received)
    guard !request.isCancelled else { return .failed("app_cancel") }
    guard status == errSecSuccess else { return .failed(statusCode(status)) }
    guard let data = received as? Data, data == expected else {
      return .failed("authentication_failed")
    }
    return .authenticated
  }

  private func errorCode(_ error: NSError?) -> String {
    guard let error, error.domain == LAError.errorDomain else { return "not_available" }
    switch error.code {
    case LAError.passcodeNotSet.rawValue: return "passcode_not_set"
    case LAError.userCancel.rawValue: return "user_cancel"
    case LAError.appCancel.rawValue: return "app_cancel"
    case LAError.systemCancel.rawValue: return "system_cancel"
    case LAError.biometryLockout.rawValue: return "lockout"
    default: return "not_available"
    }
  }

  private func statusCode(_ status: OSStatus) -> String {
    switch status {
    case errSecUserCanceled: return "user_cancel"
    case errSecAuthFailed: return "authentication_failed"
    case errSecInteractionNotAllowed: return "not_interactive"
    default: return "not_available"
    }
  }
}
