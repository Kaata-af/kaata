import CommonCrypto
import ExpoModulesCore
import Foundation

public final class KaataBackupCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KaataBackupCrypto")

    AsyncFunction("derivePersonalBackupKey") { (password: Data, salt: Data) -> Data in
      // 256 Unicode scalar values fit in 1024 UTF-8 bytes. The explicit byte
      // count preserves embedded zeroes without relying on C string length.
      guard !password.isEmpty, password.count <= 1024, salt.count == 16 else {
        throw BackupKeyDerivationException()
      }
      let keyLength = 32
      var key = Data(count: keyLength)
      let status = password.withUnsafeBytes { passwordBytes in
        salt.withUnsafeBytes { saltBytes in
          key.withUnsafeMutableBytes { keyBytes in
            CCKeyDerivationPBKDF(
              CCPBKDFAlgorithm(kCCPBKDF2),
              passwordBytes.bindMemory(to: CChar.self).baseAddress,
              passwordBytes.count,
              saltBytes.bindMemory(to: UInt8.self).baseAddress,
              saltBytes.count,
              CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
              600_000,
              keyBytes.bindMemory(to: UInt8.self).baseAddress,
              keyLength
            )
          }
        }
      }
      guard status == kCCSuccess else {
        key.resetBytes(in: 0..<keyLength)
        throw BackupKeyDerivationException()
      }
      return key
    }
  }
}

private final class BackupKeyDerivationException: Exception, @unchecked Sendable {
  override var reason: String { "Unable to derive the personal backup key" }
}
