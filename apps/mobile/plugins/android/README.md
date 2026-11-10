# Android DNS recovery

`withAndroidDnsFallback` installs `KaataDnsFallback` before React Native starts.
Both React Native 0.88's networking module and Expo SDK 58's `ExpoFetchModule`
create their clients through `OkHttpClientProvider`. The factory retains RN's
cookie container, timeouts and 10 MiB HTTP cache. It changes only DNS lookup.

The system resolver always runs first. Only an `UnknownHostException` for the
exact `api.kaata.af` hostname can use recovery. An ordinary active Internet
network is required; explicit Private DNS, VPN, a configured HTTP proxy, captive
portal, unknown policy, and offline states prevent recovery, including reuse of cached addresses.
Unvalidated networks remain eligible because DNS failure can prevent validation.

Recovery asks Google Public DNS, then Cloudflare, using their documented HTTPS
JSON endpoints. It uses public numeric bootstrap addresses, with IPv6 addresses
first on IPv6-only networks. It does not change the API URL, TLS server name,
certificate checks, or system DNS settings. Resolver clients have no account
headers, cookies, authenticators, redirects or disk cache. Answers must match
the requested question/CNAME chain and contain public literal IPv4/IPv6
addresses. The total recovery deadline is four seconds. Simultaneous lookups
share work; positive fallback answers are kept in memory only, on that network,
for no longer than their shortest TTL or five minutes. Policy is checked again
before cached or completed answers are used.

This is native Android code, so it requires a new native app build and does not
alter Expo Go or iOS. It cannot repair a failed connection after successful DNS,
the system browser's lookup, Google Play Services' own networking, or a broken
explicit Private DNS/VPN configuration. The system lookup's own blocking time
is controlled by Android; the four-second deadline bounds only added recovery.

Primary references reviewed for this implementation:

- [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/)
- [Android Private DNS policy](<https://developer.android.com/reference/android/net/LinkProperties#getPrivateDnsServerName()>)
- [Google DNS over HTTPS JSON](https://developers.google.com/speed/public-dns/docs/doh/json)
- [Google secure DNS transports and addresses](https://developers.google.com/speed/public-dns/docs/secure-transports)
- [Cloudflare DNS JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)
- [Cloudflare public resolver addresses](https://developers.cloudflare.com/1.1.1.1/ip-addresses/)

JSON DNS is a documented provider API rather than a standardized wire format.
An incompatible/malformed response fails closed; it never disables HTTPS
verification or falls back to plaintext DNS. The app privacy policy describes
the limited hostname-only lookup disclosure to these resolvers.

## Regression checks

From the repository root:

```powershell
node --test apps/mobile/plugins/withAndroidDnsFallback.test.cjs
pwsh -File apps/mobile/plugins/android/tests/run-tests.ps1
```

The second command compiles the exact production Kotlin source and runs offline
JVM checks for host scope, policy gates, TTL/network cache expiry, concurrent
lookups, recovery deadlines, IPv6, literal/address validation, CNAMEs, and
resolver credential isolation. It writes only to `build/android-dns-tests`.
It does not install an APK, modify the native project, or call real resolvers.

The runner uses the Android SDK 37.0 platform, a JDK, and dependencies already in
the Gradle cache. Run the project's Android compile first to populate its normal
build dependencies. The exact tested cache versions are Kotlin compiler 2.2.21,
stdlib 2.3.0 (compiler stdlib 2.2.21), reflect 2.2.10, script runtime/daemon 2.2.21,
Trove 1.0.20200330, coroutines 1.8.0, annotations 23.0.0, React Android 0.88.0,
OkHttp 4.12.0, Okio 3.16.0, and the test-only JSON implementation 20231013.
The JSON implementation is needed because Android's desktop `android.jar`
contains API stubs rather than executable JSON methods. No dependency is added
to the shipped app. Missing/ambiguous cached artifacts fail with an explanation;
the runner never downloads dependencies silently. Pass `-GradleCache`,
`-AndroidSdk`, or `-Java` to use nonstandard installations. Review these test
versions when updating the native build dependencies.

Live Android instrumentation remains necessary for platform policy extraction,
the actual system trust store, bootstrapped HTTPS, and application startup. The
offline checks complement that device validation.
