package af.kaata.app.network

import java.io.IOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.Dns

/** Offline JVM regressions for the exact source copied into the native app. */
fun main() {
  var checks = 0
  fun verify(value: Boolean, label: String) {
    check(value) { label }
    checks++
    println("PASS $label")
  }
  fun missing() = object : Dns {
    override fun lookup(hostname: String): List<InetAddress> = throw UnknownHostException("system lookup failed")
  }
  fun unknown(block: () -> Unit): UnknownHostException {
    try { block() } catch (failure: UnknownHostException) { return failure }
    error("Expected UnknownHostException")
  }
  fun invalid(block: () -> Unit) {
    try { block() } catch (_: Exception) { return }
    error("Expected rejection")
  }
  val address = listOf(numericAddress("8.8.8.8"))
  val ordinary = DnsPolicy(41)
  val untouched = AtomicInteger()
  val never = FallbackResolver { _, _, _ -> untouched.incrementAndGet(); error("Unexpected fallback") }
  val successfulSystem = object : Dns { override fun lookup(hostname: String) = address }
  verify(RecoveringDns(successfulSystem, { ordinary }, never).lookup(API_HOST) == address,
    "successful system DNS remains unchanged")
  val scoped = RecoveringDns(missing(), { ordinary }, never)
  for (host in listOf("accounts.google.com", "api.kaata.af.attacker.invalid", "kaata.af", "localhost")) {
    unknown { scoped.lookup(host) }
  }
  verify(untouched.get() == 0, "only the exact API hostname can use fallback")
  for (reason in listOf("PRIVATE_DNS", "VPN", "OFFLINE", "NETWORK_POLICY", "CAPTIVE_PORTAL")) {
    val failed = unknown {
      RecoveringDns(missing(), { ordinary.copy(blockedReason = "KAATA_DNS_$reason") }, never).lookup(API_HOST)
    }
    verify(failed.message == "KAATA_DNS_$reason", "observed policy $reason keeps its bounded diagnostic")
  }
  verify(untouched.get() == 0, "blocked policy never queries a public resolver")

  val clock = AtomicLong(TimeUnit.SECONDS.toNanos(1))
  val calls = AtomicInteger()
  val currentPolicy = AtomicReference(ordinary)
  val cached = RecoveringDns(missing(), { currentPolicy.get() }, FallbackResolver { _, _, _ ->
    calls.incrementAndGet()
    DnsAnswer(address, clock.get() + TimeUnit.SECONDS.toNanos(30))
  }, { clock.get() })
  cached.lookup(API_HOST)
  cached.lookup(API_HOST)
  verify(calls.get() == 1, "positive cache reused before TTL")
  clock.addAndGet(TimeUnit.SECONDS.toNanos(31))
  cached.lookup(API_HOST)
  verify(calls.get() == 2, "expired fallback answers queried again")
  currentPolicy.set(DnsPolicy(42))
  cached.lookup(API_HOST)
  verify(calls.get() == 3, "network change invalidates cached answers")
  currentPolicy.set(DnsPolicy(42, blockedReason = "KAATA_DNS_PRIVATE_DNS"))
  unknown { cached.lookup(API_HOST) }
  verify(calls.get() == 3, "cache cannot bypass an explicit Private DNS setting")
  val zeroCalls = AtomicInteger()
  val zeroTtl = RecoveringDns(missing(), { ordinary }, FallbackResolver { _, _, _ ->
    zeroCalls.incrementAndGet(); DnsAnswer(address, clock.get())
  }, { clock.get() })
  zeroTtl.lookup(API_HOST)
  zeroTtl.lookup(API_HOST)
  verify(zeroCalls.get() == 2, "zero TTL never cached")
  val limitedCalls = AtomicInteger()
  val limited = RecoveringDns(missing(), { ordinary }, FallbackResolver { _, _, _ ->
    limitedCalls.incrementAndGet(); DnsAnswer(address, clock.get() + TimeUnit.HOURS.toNanos(1))
  }, { clock.get() })
  limited.lookup(API_HOST)
  clock.addAndGet(TimeUnit.SECONDS.toNanos(301))
  limited.lookup(API_HOST)
  verify(limitedCalls.get() == 2, "fallback cache capped at five minutes")

  val workers = Executors.newFixedThreadPool(6)
  try {
    val start = CountDownLatch(1)
    val sharedCalls = AtomicInteger()
    val shared = RecoveringDns(missing(), { ordinary }, FallbackResolver { _, _, _ ->
      sharedCalls.incrementAndGet()
      Thread.sleep(100)
      DnsAnswer(address, System.nanoTime() + TimeUnit.SECONDS.toNanos(30))
    })
    val replies = (1..6).map { workers.submit<List<InetAddress>> { start.await(); shared.lookup(API_HOST) } }
    start.countDown()
    verify(replies.all { it.get(5, TimeUnit.SECONDS) == address }, "all concurrent callers receive the answer")
    verify(sharedCalls.get() == 1, "concurrent failed lookups share one recovery")

    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val changing = AtomicReference(ordinary)
    val inFlight = RecoveringDns(missing(), { changing.get() }, FallbackResolver { _, _, _ ->
      entered.countDown()
      release.await(2, TimeUnit.SECONDS)
      DnsAnswer(address, System.nanoTime() + TimeUnit.SECONDS.toNanos(30))
    })
    val reply = workers.submit<UnknownHostException> { unknown { inFlight.lookup(API_HOST) } }
    check(entered.await(2, TimeUnit.SECONDS))
    changing.set(ordinary.copy(blockedReason = "KAATA_DNS_VPN"))
    release.countDown()
    verify(reply.get(3, TimeUnit.SECONDS).message == "KAATA_DNS_VPN", "policy rechecked after an in-flight response")
  } finally {
    workers.shutdownNow()
  }

  val resolverFailure = RecoveringDns(missing(), { ordinary }, FallbackResolver { _, _, _ ->
    throw javax.net.ssl.SSLHandshakeException("Resolver certificate failure")
  })
  val failure = unknown { resolverFailure.lookup(API_HOST) }
  verify(failure.cause is UnknownHostException && failure.cause?.cause == null,
    "resolver TLS errors are not misreported as API TLS errors")

  val noNetwork = DohResolver(DohTransport { _, _, _, _, _ -> Thread.sleep(6000); error("timeout required") })
  val started = System.nanoTime()
  unknown { noNetwork.resolve(API_HOST, started + TimeUnit.SECONDS.toNanos(4), false) }
  val elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
  verify(elapsed in 3500..4500, "both unavailable providers share one four-second budget ($elapsed ms)")

  val secondaryCalls = AtomicInteger()
  val ipv6 = DohResolver(DohTransport { endpoint, _, type, _, _ ->
    if (endpoint.hostname == "cloudflare-dns.com") secondaryCalls.incrementAndGet()
    val values = if (type == 1) address else if (endpoint.hostname == "cloudflare-dns.com")
      listOf(numericAddress("2606:4700:4700::1111")) else emptyList()
    DnsAnswer(values, System.nanoTime() + TimeUnit.SECONDS.toNanos(30))
  }).resolve(API_HOST, System.nanoTime() + TimeUnit.SECONDS.toNanos(4), true)
  verify(secondaryCalls.get() == 2 && ipv6.addresses.first() is Inet6Address,
    "IPv6-only recovery tries the secondary provider when primary has only A")

  val transport = OkHttpDohTransport()
  for (endpoint in DOH_ENDPOINTS) {
    val request = transport.request(endpoint, API_HOST, 1)
    val client = transport.client(endpoint, false)
    verify(request.url.isHttps && request.url.host == endpoint.hostname, "resolver keeps HTTPS hostname ${endpoint.hostname}")
    verify(request.header("Authorization") == null && request.header("Cookie") == null &&
      request.header("Proxy-Authorization") == null, "resolver carries no account credential headers")
    verify(client.cookieJar === CookieJar.NO_COOKIES && client.authenticator === Authenticator.NONE &&
      client.proxyAuthenticator === Authenticator.NONE, "resolver cannot inherit cookies or authenticators")
    verify(client.cache == null && client.interceptors.isEmpty() && client.networkInterceptors.isEmpty(),
      "resolver has no app cache or interceptors")
    verify(!client.followRedirects && !client.followSslRedirects, "resolver refuses redirects")
    val bootstrap = client.dns.lookup(endpoint.hostname)
    verify(bootstrap[0] is Inet4Address && bootstrap[1] is Inet6Address,
      "bootstrap interleaves families on ordinary networks")
    verify(transport.client(endpoint, true).dns.lookup(endpoint.hostname).take(2).all { it is Inet6Address },
      "IPv6-only bootstrap prioritizes both IPv6 routes")
    unknown { client.dns.lookup("unrelated.invalid") }
    verify(true, "bootstrap cannot resolve any other hostname")
  }

  val now = 10_000_000L
  fun record(ip: String = "8.8.8.8", ttl: Int = 30, question: String = API_HOST, type: Int = 1) =
    """{"Status":0,"Question":[{"name":"$question.","type":$type}],"Answer":[{"name":"$API_HOST.","type":$type,"TTL":$ttl,"data":"$ip"}]}"""
  val valid = parseDnsAnswer(record(), API_HOST, 1, now)
  verify(valid.addresses == address && valid.expiresAtNanos == now + TimeUnit.SECONDS.toNanos(30), "public answer retains its TTL")
  verify(parseDnsAnswer(record(ttl = 900), API_HOST, 1, now).expiresAtNanos == now + TimeUnit.SECONDS.toNanos(300), "parsed TTL capped")
  verify(parseDnsAnswer(record(), API_HOST, 1, now, 20).expiresAtNanos == now + TimeUnit.SECONDS.toNanos(10), "HTTP Age subtracts from TTL")
  verify(parseDnsAnswer(record(), API_HOST, 1, now, 90).expiresAtNanos == now, "old HTTP answers not cached")
  for (ip in listOf("127.0.0.1", "192.168.1.1", "10.0.0.1", "100.64.0.1", "169.254.1.1", "203.0.113.1", "224.0.0.1")) {
    invalid { parseDnsAnswer(record(ip = ip), API_HOST, 1, now) }
    verify(true, "nonpublic IPv4 rejected $ip")
  }
  for (ip in listOf("::1", "fc00::1", "fe80::1", "2001:db8::1", "2002:c0a8:101::1", "3fff::1")) {
    invalid { parseDnsAnswer(record(ip = ip, type = 28), API_HOST, 28, now) }
    verify(true, "nonpublic IPv6 rejected $ip")
  }
  invalid { parseDnsAnswer(record(question = "unrelated.invalid"), API_HOST, 1, now) }
  invalid { parseDnsAnswer(record(ttl = -1), API_HOST, 1, now) }
  invalid { parseDnsAnswer(record(ip = "google.com"), API_HOST, 1, now) }
  invalid { parseDnsAnswer(record().replace("\"Status\":0", "\"Status\":3"), API_HOST, 1, now) }
  verify(true, "mismatched question, TTL, hostname answer and DNS failure rejected")
  val cname = """{"Status":0,"Question":[{"name":"api.kaata.af.","type":1}],"Answer":[{"name":"api.kaata.af.","type":5,"TTL":5,"data":"alias.example."},{"name":"alias.example.","type":1,"TTL":30,"data":"8.8.8.8"},{"name":"unrelated.example.","type":1,"TTL":30,"data":"1.1.1.1"}]}"""
  val alias = parseDnsAnswer(cname, API_HOST, 1, now)
  verify(alias.addresses == address && alias.expiresAtNanos == now + TimeUnit.SECONDS.toNanos(5),
    "CNAME chain uses shortest TTL and ignores unrelated answers")
  println("DNS_REGRESSIONS_PASSED=$checks")
}
