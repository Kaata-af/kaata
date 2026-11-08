import ExpoModulesCore
import Foundation

public class KaataICloudBackupModule: Module {
  private static let containerID = "iCloud.af.kaata.app"
  private static let bindingKey = "kaata.personal-backup.icloud-account"
  private let files = FileManager.default
  private let queue = DispatchQueue(label: "af.kaata.icloud-backup", qos: .utility)

  public func definition() -> ModuleDefinition {
    Name("KaataICloudBackup")

    AsyncFunction("connect") { (promise: Promise) in
      do {
        let account = try self.account()
        _ = try self.backupsFolder(for: account)
        promise.resolve(account.id)
      } catch {
        promise.reject(self.providerError(error))
      }
    }.runOnQueue(queue)

    AsyncFunction("upload") {
      (connection: String, scope: String, device: String, sourceUri: String,
       createdAt: Double, limit: Int, promise: Promise) in
      do {
        let account = try self.account(expected: connection)
        let folder = try self.backupsFolder(for: account)
        let name = try self.backupName(scope: scope, device: device)
        let source = try self.cacheFile(sourceUri)
        let size = try self.archiveSize(source, limit: limit)
        guard createdAt.isFinite, createdAt > 0 else {
          throw self.failure("E_ICLOUD_PROVIDER", "Invalid Kaata backup date.")
        }
        let date = Date(timeIntervalSince1970: createdAt / 1_000)
        let target = folder.appendingPathComponent(name)

        try self.createFolder(folder, account: account)
        var coordinationError: NSError?
        var writeResult: Result<Void, Error>?
        let coordinator = NSFileCoordinator(filePresenter: nil)
        coordinator.coordinate(writingItemAt: target, options: .forReplacing, error: &coordinationError) { url in
          writeResult = Result {
            let staging = try self.files.url(
              for: .itemReplacementDirectory, in: .userDomainMask,
              appropriateFor: url.deletingLastPathComponent(), create: true
            )
            defer { try? self.files.removeItem(at: staging) }
            let archive = staging.appendingPathComponent(name)
            try self.files.copyItem(at: source, to: archive)
            try self.files.setAttributes([.modificationDate: date], ofItemAtPath: archive.path)
            try self.checkAccount(account)
            let backups = url.deletingLastPathComponent()
            try self.requirePrivate(backups.deletingLastPathComponent())
            try self.requirePrivate(backups)
            if self.files.fileExists(atPath: url.path) || self.files.isUbiquitousItem(at: url) {
              try self.requirePrivate(url)
              _ = try self.files.replaceItemAt(url, withItemAt: archive, options: .usingNewMetadataOnly)
            } else {
              try self.files.moveItem(at: archive, to: url)
            }
          }
        }
        try self.complete(coordinationError, writeResult)
        try self.checkAccount(account)
        promise.resolve(ICloudBackupCopy(id: device, name: name, date: date, size: size, pending: true).bridgeValue)
      } catch {
        promise.reject(self.providerError(error))
      }
    }.runOnQueue(queue)

    AsyncFunction("list") { (connection: String, scope: String, promise: Promise) in
      do {
        let account = try self.account(expected: connection)
        let folder = try self.backupsFolder(for: account)
        let prefix = try self.backupPrefix(scope)
        DispatchQueue.main.async {
          ICloudBackupQuery(prefix: prefix, folder: folder) { result in
            self.queue.async {
              do {
                try self.checkAccount(account)
                let indexed = try result.get()
                let local = (try? self.localCopies(folder: folder, prefix: prefix)) ?? []
                var copies: [String: ICloudBackupCopy] = [:]
                for copy in indexed + local {
                  if let existing = copies[copy.id], existing.preferred(over: copy) { continue }
                  copies[copy.id] = copy
                }
                try self.checkAccount(account)
                promise.resolve(copies.values.sorted { $0.createdAt > $1.createdAt }.map(\.bridgeValue))
              } catch {
                promise.reject(self.providerError(error))
              }
            }
          }.start()
        }
      } catch {
        promise.reject(self.providerError(error))
      }
    }.runOnQueue(queue)

    AsyncFunction("download") {
      (connection: String, scope: String, device: String, destinationUri: String,
       createdAt: Double, expectedSize: Int, limit: Int, promise: Promise) in
      do {
        let account = try self.account(expected: connection)
        let folder = try self.backupsFolder(for: account)
        let name = try self.backupName(scope: scope, device: device)
        let source = folder.appendingPathComponent(name)
        let destination = try self.cacheFile(destinationUri)

        // A coordinated read of an evicted file waits for iCloud to fetch it.
        // Cancel the wait if iCloud cannot make progress during this request.
        var coordinationError: NSError?
        var readResult: Result<Void, Error>?
        let coordinator = NSFileCoordinator(filePresenter: nil)
        let timeout = DispatchWorkItem { coordinator.cancel() }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 45, execute: timeout)
        defer { timeout.cancel() }
        coordinator.coordinate(readingItemAt: source, options: .withoutChanges, error: &coordinationError) { url in
          readResult = Result {
            try self.checkAccount(account)
            let size = try self.archiveSize(url, limit: limit)
            let date = try url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
            guard size == expectedSize, let date,
                  (date.timeIntervalSince1970 * 1_000).rounded() == createdAt else {
              throw self.failure("E_ICLOUD_PROVIDER", "This iCloud backup changed. Refresh the backup list and try again.")
            }
            let staged = destination.deletingLastPathComponent()
              .appendingPathComponent(".kaata-icloud-\(UUID().uuidString).zip")
            defer { try? self.files.removeItem(at: staged) }
            try self.files.copyItem(at: url, to: staged)
            try self.checkAccount(account)
            try self.files.moveItem(at: staged, to: destination)
          }
        }
        if coordinationError?.domain == NSCocoaErrorDomain, coordinationError?.code == NSUserCancelledError {
          throw self.failure("E_ICLOUD_OFFLINE", "iCloud Drive could not finish downloading the backup.")
        }
        try self.complete(coordinationError, readResult)
        promise.resolve()
      } catch {
        promise.reject(self.providerError(error))
      }
    }.runOnQueue(queue)
  }

  private typealias IdentityToken = any (NSCoding & NSCopying & NSObjectProtocol)
  private typealias Account = (id: String, token: IdentityToken)

  private func account(expected: String? = nil) throws -> Account {
    guard let token = files.ubiquityIdentityToken else {
      throw failure("E_ICLOUD_RECONNECT", "Turn on iCloud Drive in Settings to back up to iCloud.")
    }
    let defaults = UserDefaults.standard
    if let binding = defaults.dictionary(forKey: Self.bindingKey),
       let id = binding["id"] as? String,
       let data = binding["token"] as? Data,
       let previous = try? NSKeyedUnarchiver.unarchiveTopLevelObjectWithData(data),
       token.isEqual(previous) {
      if let expected, expected != id {
        throw failure("E_ICLOUD_RECONNECT", "Reconnect iCloud Drive to continue backing up.")
      }
      return (id, token)
    }
    guard expected == nil else {
      throw failure("E_ICLOUD_RECONNECT", "Reconnect iCloud Drive to continue backing up.")
    }
    // Apple supplies an opaque NSCoding token. Keep it on this device and expose
    // only a random connection ID, so a new Apple Account needs fresh consent.
    let id = UUID().uuidString
    let data = try NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: false)
    defaults.set(["id": id, "token": data], forKey: Self.bindingKey)
    return (id, token)
  }

  private func checkAccount(_ account: Account) throws {
    guard files.ubiquityIdentityToken?.isEqual(account.token) == true else {
      throw failure("E_ICLOUD_RECONNECT", "The iCloud account changed. Reconnect iCloud Drive to continue.")
    }
  }

  private func backupsFolder(for account: Account) throws -> URL {
    guard let container = files.url(forUbiquityContainerIdentifier: Self.containerID) else {
      throw failure("E_ICLOUD_RECONNECT", "Kaata could not open iCloud Drive. Check iCloud Drive settings and try again.")
    }
    try checkAccount(account)
    return container.appendingPathComponent("Documents", isDirectory: true)
      .appendingPathComponent("Backups", isDirectory: true)
  }

  private func createFolder(_ folder: URL, account: Account) throws {
    var coordinationError: NSError?
    var result: Result<Void, Error>?
    NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: folder, options: [], error: &coordinationError) { url in
      result = Result {
        try self.checkAccount(account)
        try self.files.createDirectory(at: url, withIntermediateDirectories: true)
      }
    }
    try complete(coordinationError, result)
  }

  private func requirePrivate(_ url: URL) throws {
    let values = try url.resourceValues(forKeys: [.ubiquitousItemIsSharedKey])
    if values.ubiquitousItemIsShared == true {
      throw failure("E_ICLOUD_PROVIDER", "Stop sharing the iCloud backup file or folder to resume automatic backups.")
    }
  }

  private func complete(_ error: NSError?, _ result: Result<Void, Error>?) throws {
    if let error { throw error }
    guard let result else {
      throw failure("E_ICLOUD_PROVIDER", "iCloud Drive could not open the backup file.")
    }
    try result.get()
  }

  private func backupPrefix(_ scope: String) throws -> String {
    guard isBackupKey(scope) else {
      throw failure("E_ICLOUD_PROVIDER", "Invalid Kaata backup account.")
    }
    return "Kaata-backup-\(scope)-"
  }

  private func backupName(scope: String, device: String) throws -> String {
    guard isBackupKey(device) else {
      throw failure("E_ICLOUD_PROVIDER", "Invalid Kaata backup device.")
    }
    return try backupPrefix(scope) + device + ".zip"
  }

  private func cacheFile(_ uri: String) throws -> URL {
    guard let url = URL(string: uri), url.isFileURL, url.host?.isEmpty != false,
          let cache = files.urls(for: .cachesDirectory, in: .userDomainMask).first else {
      throw failure("E_ICLOUD_PROVIDER", "Invalid Kaata backup file location.")
    }
    let file = url.standardizedFileURL.resolvingSymlinksInPath()
    guard file.path.hasPrefix(cache.resolvingSymlinksInPath().path + "/") else {
      throw failure("E_ICLOUD_PROVIDER", "Invalid Kaata backup file location.")
    }
    return file
  }

  private func archiveSize(_ url: URL, limit: Int) throws -> Int {
    let resource = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
    guard resource.isRegularFile == true, resource.isSymbolicLink != true, let size = resource.fileSize, size > 0 else {
      throw failure("E_ICLOUD_PROVIDER", "The iCloud backup file is missing or unreadable.")
    }
    guard size <= limit else {
      throw failure("E_ICLOUD_TOO_LARGE", "The iCloud backup file is too large.")
    }
    return size
  }

  private func localCopies(folder: URL, prefix: String) throws -> [ICloudBackupCopy] {
    guard files.fileExists(atPath: folder.path) else { return [] }
    let keys: Set<URLResourceKey> = [
      .contentModificationDateKey, .fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey,
      .ubiquitousItemIsUploadedKey, .ubiquitousItemIsUploadingKey, .ubiquitousItemUploadingErrorKey
    ]
    var coordinationError: NSError?
    var result: Result<[ICloudBackupCopy], Error>?
    NSFileCoordinator(filePresenter: nil).coordinate(
      readingItemAt: folder, options: .immediatelyAvailableMetadataOnly, error: &coordinationError
    ) { url in
      result = Result {
        let children = try self.files.contentsOfDirectory(at: url, includingPropertiesForKeys: Array(keys), options: .skipsHiddenFiles)
        return children.compactMap { child in
          guard let device = backupDevice(for: child.lastPathComponent, prefix: prefix),
                let values = try? child.resourceValues(forKeys: keys),
                values.isRegularFile == true, values.isSymbolicLink != true,
                let date = values.contentModificationDate, let size = values.fileSize, size > 0 else { return nil }
          let quotaExceeded = isUploadQuotaError(values.ubiquitousItemUploadingError)
          let pending = quotaExceeded || values.ubiquitousItemIsUploaded != true || values.ubiquitousItemIsUploading == true
          return ICloudBackupCopy(id: device, name: child.lastPathComponent, date: date, size: size,
                                  pending: pending, quotaExceeded: quotaExceeded)
        }
      }
    }
    if let coordinationError { throw coordinationError }
    return try result?.get() ?? []
  }

  private func failure(_ code: String, _ message: String) -> Exception {
    Exception(name: code, description: message, code: code)
  }

  private func providerError(_ error: Error) -> Exception {
    if let exception = error as? Exception { return exception }
    let native = error as NSError
    if native.domain == NSCocoaErrorDomain {
      switch native.code {
      case NSUbiquitousFileUnavailableError, NSUbiquitousFileUbiquityServerNotAvailable:
        return failure("E_ICLOUD_OFFLINE", "iCloud Drive is temporarily unavailable.")
      case NSUbiquitousFileNotUploadedDueToQuotaError:
        return failure("E_ICLOUD_PROVIDER", "Your iCloud storage is full.")
      default:
        break
      }
    }
    return failure("E_ICLOUD_PROVIDER", "iCloud Drive could not complete the backup operation.")
  }
}

private func isBackupKey(_ value: String) -> Bool {
  value.range(of: #"\A[0-9a-f]{32}\z"#, options: .regularExpression) != nil
}

private func backupDevice(for name: String, prefix: String) -> String? {
  guard name.hasPrefix(prefix), name.hasSuffix(".zip") else { return nil }
  let device = String(name.dropFirst(prefix.count).dropLast(4))
  return isBackupKey(device) ? device : nil
}

private func isUploadQuotaError(_ error: Error?) -> Bool {
  guard let error else { return false }
  let native = error as NSError
  return native.domain == NSCocoaErrorDomain && native.code == NSUbiquitousFileNotUploadedDueToQuotaError
}

private struct ICloudBackupCopy {
  let id: String
  let name: String
  let date: Date
  let size: Int
  let pending: Bool
  var quotaExceeded = false

  var createdAt: Double { (date.timeIntervalSince1970 * 1_000).rounded() }
  var bridgeValue: [String: Any] {
    var value: [String: Any] = ["id": id, "name": name, "createdAt": createdAt, "size": size, "pending": pending]
    if quotaExceeded { value["error"] = "providerFailed" }
    return value
  }

  func preferred(over copy: ICloudBackupCopy) -> Bool {
    if createdAt != copy.createdAt { return createdAt > copy.createdAt }
    if pending != copy.pending { return !pending }
    return quotaExceeded && !copy.quotaExceeded
  }
}

// A fresh query finds archives even when iOS has only synced their metadata.
// Never list ordinary Files documents outside the Kaata container and folder.
private final class ICloudBackupQuery {
  private let query = NSMetadataQuery()
  private let folder: URL
  private let prefix: String
  private var completion: ((Result<[ICloudBackupCopy], Error>) -> Void)?
  private var observer: NSObjectProtocol?

  init(prefix: String, folder: URL, completion: @escaping (Result<[ICloudBackupCopy], Error>) -> Void) {
    self.folder = folder
    self.prefix = prefix
    self.completion = completion
  }

  func start() {
    query.searchScopes = [NSMetadataQueryUbiquitousDocumentsScope]
    query.predicate = NSPredicate(format: "%K LIKE %@", NSMetadataItemFSNameKey, prefix + "*.zip")
    observer = NotificationCenter.default.addObserver(
      forName: .NSMetadataQueryDidFinishGathering, object: query, queue: .main
    ) { [weak self] _ in self?.finishGathering() }
    guard query.start() else {
      finish(.failure(Exception(name: "E_ICLOUD_PROVIDER", description: "Could not list iCloud backups.", code: "E_ICLOUD_PROVIDER")))
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
      self.finish(.failure(Exception(name: "E_ICLOUD_OFFLINE", description: "iCloud Drive did not respond.", code: "E_ICLOUD_OFFLINE")))
    }
  }

  private func finishGathering() {
    query.disableUpdates()
    let folderPath = folder.resolvingSymlinksInPath().path
    let copies: [ICloudBackupCopy] = query.results.compactMap { result in
      guard let item = result as? NSMetadataItem,
            let url = item.value(forAttribute: NSMetadataItemURLKey) as? URL,
            url.deletingLastPathComponent().resolvingSymlinksInPath().path == folderPath,
            let name = item.value(forAttribute: NSMetadataItemFSNameKey) as? String,
            let device = backupDevice(for: name, prefix: prefix),
            let date = item.value(forAttribute: NSMetadataItemFSContentChangeDateKey) as? Date,
            let size = item.value(forAttribute: NSMetadataItemFSSizeKey) as? NSNumber, size.intValue > 0 else { return nil }
      let uploaded = item.value(forAttribute: NSMetadataUbiquitousItemIsUploadedKey) as? NSNumber
      let uploading = item.value(forAttribute: NSMetadataUbiquitousItemIsUploadingKey) as? NSNumber
      let quotaExceeded = isUploadQuotaError(item.value(forAttribute: NSMetadataUbiquitousItemUploadingErrorKey) as? NSError)
      let pending = quotaExceeded || uploaded?.boolValue != true || uploading?.boolValue == true
      let download = item.value(forAttribute: NSMetadataUbiquitousItemDownloadingStatusKey) as? String
      guard !pending || download == NSMetadataUbiquitousItemDownloadingStatusCurrent else { return nil }
      return ICloudBackupCopy(id: device, name: name, date: date, size: size.intValue,
                              pending: pending, quotaExceeded: quotaExceeded)
    }
    finish(.success(copies))
  }

  private func finish(_ result: Result<[ICloudBackupCopy], Error>) {
    guard let completion else { return }
    self.completion = nil
    if let observer { NotificationCenter.default.removeObserver(observer) }
    if query.isStarted { query.stop() }
    completion(result)
  }
}
