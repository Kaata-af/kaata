import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

/// The system "Save to Files" for ONE file.
///
/// UIDocumentPickerViewController in EXPORT mode with `asCopy: true`: the user
/// picks a destination and iOS copies the file there itself. No directory
/// grant, no security-scoped bookmark on our side, and nothing for us to write
/// — which is what removes the crash the old directory-picker round-trip hit.
///
/// The picker is presented on the current view controller ~220ms after the
/// action sheet dismissed (the JS side pads for that), so we never present on
/// a view controller that is itself being torn down.
///
/// The delegate must be retained for the life of the picker; UIKit holds it
/// weakly. `Coordinator` owns the promise and releases itself on completion.
public class KaataSaveFileModule: Module {
  private var coordinator: Coordinator?

  public func definition() -> ModuleDefinition {
    Name("KaataSaveFile")

    // Android's entry point; present so JS calls one name on both platforms.
    AsyncFunction("saveToDownloads") { (_: String, _: String, _: String, promise: Promise) in
      promise.reject(Exception(name: "E_UNSUPPORTED", description: "saveToDownloads is Android-only", code: "E_UNSUPPORTED"))
    }

    AsyncFunction("exportFile") { (sourceUri: String, fileName: String, promise: Promise) in
      // expo-print hands us a file:// URI; accept a bare path too.
      let parsed = URL(string: sourceUri)
      let source = (parsed?.isFileURL == true) ? parsed! : URL(fileURLWithPath: sourceUri)
      guard FileManager.default.fileExists(atPath: source.path) else {
        promise.reject(Exception(name: "E_SOURCE", description: "cannot open \(sourceUri)", code: "E_SOURCE"))
        return
      }
      guard let vc = self.appContext?.utilities?.currentViewController() else {
        promise.reject(Exception(name: "E_NO_VIEW", description: "no view controller to present on", code: "E_NO_VIEW"))
        return
      }

      // Export the file under the name the caller wants, not expo-print's
      // temp name. Stage a copy in tmp with that name; asCopy means iOS reads
      // it and we can drop the stage afterwards.
      let stageDir = FileManager.default.temporaryDirectory
        .appendingPathComponent("kaata-save-\(UUID().uuidString)", isDirectory: true)
      let staged = stageDir.appendingPathComponent(fileName)
      do {
        try FileManager.default.createDirectory(at: stageDir, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: source, to: staged)
      } catch {
        promise.reject(Exception(name: "E_WRITE", description: error.localizedDescription, code: "E_WRITE"))
        return
      }

      let picker = UIDocumentPickerViewController(forExporting: [staged], asCopy: true)
      picker.shouldShowFileExtensions = true
      let coordinator = Coordinator(promise: promise, stageDir: stageDir) { [weak self] in
        self?.coordinator = nil
      }
      self.coordinator = coordinator
      picker.delegate = coordinator
      vc.present(picker, animated: true)
    }
  }

  final class Coordinator: NSObject, UIDocumentPickerDelegate {
    private var promise: Promise?
    private let stageDir: URL
    private let done: () -> Void

    init(promise: Promise, stageDir: URL, done: @escaping () -> Void) {
      self.promise = promise
      self.stageDir = stageDir
      self.done = done
    }

    private func finish(_ block: (Promise) -> Void) {
      guard let p = promise else { return }
      promise = nil
      try? FileManager.default.removeItem(at: stageDir)
      block(p)
      done()
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
      finish { p in
        if let url = urls.first {
          p.resolve(["displayName": url.lastPathComponent, "uri": url.absoluteString])
        } else {
          p.resolve(nil)
        }
      }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
      finish { p in p.resolve(nil) }
    }
  }
}
