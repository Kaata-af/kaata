param(
  [string]$GradleCache,
  [string]$AndroidSdk,
  [string]$Java
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../../..'))
$output = Join-Path $repo 'build/android-dns-tests'
New-Item -ItemType Directory -Force -Path $output | Out-Null
if (!$GradleCache) {
  $gradleRoot = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $env:USERPROFILE '.gradle' }
  $GradleCache = Join-Path $gradleRoot 'caches/modules-2/files-2.1'
}
if (!$AndroidSdk) {
  $AndroidSdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
  if (!(Test-Path $AndroidSdk)) { $AndroidSdk = Join-Path $env:USERPROFILE 'AppData/Local/Android/Sdk' }
}
if (!$Java) {
  $studioJava = Join-Path $env:ProgramFiles 'Android/Android Studio/jbr/bin/java.exe'
  $Java = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin/java.exe' } elseif (Test-Path $studioJava) { $studioJava } else { (Get-Command java -ErrorAction Stop).Source }
}
function Dependency([string]$part, [string]$extension = 'jar') {
  $filter = if ($extension -eq 'aar') { '*-release.aar' } else { '*.' + $extension }
  $files = @(Get-ChildItem (Join-Path $GradleCache $part) -Recurse -File -Filter $filter -ErrorAction SilentlyContinue)
  if ($files.Count -ne 1) { throw "Expected one cached $part $extension. Build the Android app first, or pass -GradleCache for its cache." }
  return $files[0].FullName
}
$android = Join-Path $AndroidSdk 'platforms/android-37.0/android.jar'
if (!(Test-Path $android)) { throw 'Android SDK platform android-37.0 is required for the SDK 58 source.' }
$stdlib = Dependency 'org.jetbrains.kotlin/kotlin-stdlib/2.3.0'
$annotations = Dependency 'org.jetbrains/annotations/23.0.0'
$okhttp = Dependency 'com.squareup.okhttp3/okhttp/4.12.0'
$okio = Dependency 'com.squareup.okio/okio-jvm/3.16.0'
$json = Dependency 'org.json/json/20231013'
$reactAar = Dependency 'com.facebook.react/react-android/0.88.0' 'aar'
$react = Join-Path $output 'react-classes.jar'
$archive = [IO.Compression.ZipFile]::OpenRead($reactAar)
try {
  $entry = $archive.GetEntry('classes.jar')
  if (!$entry) { throw 'React Native AAR has no classes.jar.' }
  $source = $entry.Open()
  $target = [IO.File]::Create($react)
  try { $source.CopyTo($target) } finally { $source.Dispose(); $target.Dispose() }
} finally { $archive.Dispose() }
$compiler = @(
  (Dependency 'org.jetbrains.kotlin/kotlin-compiler-embeddable/2.2.21'),
  (Dependency 'org.jetbrains.kotlin/kotlin-stdlib/2.2.21'),
  (Dependency 'org.jetbrains.kotlin/kotlin-reflect/2.2.10'),
  (Dependency 'org.jetbrains.kotlin/kotlin-script-runtime/2.2.21'),
  (Dependency 'org.jetbrains.kotlin/kotlin-daemon-embeddable/2.2.21'),
  (Dependency 'org.jetbrains.intellij.deps/trove4j/1.0.20200330'),
  (Dependency 'org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.8.0'),
  $annotations
) -join [IO.Path]::PathSeparator
$classpath = @($json, $android, $stdlib, $annotations, $okhttp, $okio, $react) -join [IO.Path]::PathSeparator
$compiled = Join-Path $output 'dns-tests.jar'
& $Java -Xmx512m -cp $compiler org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -jvm-target 1.8 -no-stdlib -no-reflect -classpath $classpath -d $compiled (Join-Path $PSScriptRoot '../KaataDnsFallback.kt') (Join-Path $PSScriptRoot 'KaataDnsFallbackTest.kt')
if ($LASTEXITCODE -ne 0) { throw 'DNS regression compilation failed.' }
& $Java -cp "$compiled$([IO.Path]::PathSeparator)$classpath" af.kaata.app.network.KaataDnsFallbackTestKt
if ($LASTEXITCODE -ne 0) { throw 'DNS regressions failed.' }
