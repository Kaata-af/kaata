Pod::Spec.new do |s|
  s.name = 'KaataNotificationActions'
  s.version = '0.0.1'
  s.summary = 'Durable shared-account notification actions'
  s.description = s.summary
  s.license = 'UNLICENSED'
  s.author = 'Kaata'
  s.homepage = 'https://kaata.af'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
  s.resource_bundles = { 'KaataNotificationActions_privacy' => ['PrivacyInfo.xcprivacy'] }
end
