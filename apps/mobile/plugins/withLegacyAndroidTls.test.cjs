const assert = require("node:assert/strict");
const { X509Certificate } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { parseStringPromise } = require("xml2js");
const plugin = require("./withLegacyAndroidTls");

const fingerprint =
  "96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6";

async function fixture(t, cleartext = true) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "kaata-tls-test-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const config = plugin({
    name: "Kaata",
    slug: "kaata",
    plugins: [["expo-build-properties", { android: { usesCleartextTraffic: cleartext } }]],
  });
  const modRequest = { projectRoot: project, platformProjectRoot: path.join(project, "android") };
  const application = {
    $: { "android:usesCleartextTraffic": String(cleartext), "android:allowBackup": "true" },
  };
  const manifest = { manifest: { application: [application] } };
  const runManifest = () =>
    config.mods.android.manifest({ ...config, modRequest, modResults: manifest });
  const runResources = () =>
    config.mods.android.dangerous({ ...config, modRequest, modResults: {} });
  const resource = (folder, name = "kaata_network_security_config.xml") =>
    path.join(modRequest.platformProjectRoot, "app", "src", "main", "res", folder, name);
  const xml = async (folder) =>
    (await parseStringPromise(fs.readFileSync(resource(folder), "utf8")))[
      "network-security-config"
    ];
  return { application, runManifest, runResources, resource, xml };
}

test("legacy trust adds the reviewed public CA exclusively to Kaata HTTPS connections", async (t) => {
  const f = await fixture(t);
  await f.runManifest();
  await f.runResources();
  assert.equal(
    f.application.$["android:networkSecurityConfig"],
    "@xml/kaata_network_security_config",
  );
  assert.equal(f.application.$["android:allowBackup"], "true");
  assert.equal(f.application.$["android:usesCleartextTraffic"], "true");
  const legacy = await f.xml("xml");
  assert.deepEqual(
    legacy["base-config"][0]["trust-anchors"][0].certificates.map((x) => x.$.src),
    ["system"],
  );
  assert.equal(legacy["base-config"][0].$.cleartextTrafficPermitted, "true");
  const domains = legacy["domain-config"];
  assert.equal(domains.length, 1);
  assert.deepEqual(domains[0].domain, [{ _: "kaata.af", $: { includeSubdomains: "true" } }]);
  assert.equal(domains[0].$.cleartextTrafficPermitted, "false");
  assert.deepEqual(
    domains[0]["trust-anchors"][0].certificates.map((x) => x.$.src),
    ["system", "@raw/kaata_isrg_root_x1"],
  );
  assert.equal(domains[0]["pin-set"], undefined);
  const cert = new X509Certificate(fs.readFileSync(f.resource("raw", "kaata_isrg_root_x1.pem")));
  assert.equal(cert.fingerprint256, fingerprint);
  assert.equal(cert.ca, true);
  assert.equal(cert.verify(cert.publicKey), true);
  assert.match(cert.subject, /CN=ISRG Root X1/);
});

test("Android 8+ keeps only system trust and does not override certificate transparency", async (t) => {
  const f = await fixture(t);
  await f.runResources();
  const modern = await f.xml("xml-v26");
  assert.deepEqual(
    modern["base-config"][0]["trust-anchors"][0].certificates.map((x) => x.$.src),
    ["system"],
  );
  assert.equal(modern["domain-config"][0]["trust-anchors"], undefined);
  assert.equal(modern["domain-config"][0].$.cleartextTrafficPermitted, "false");
  const raw = fs.readFileSync(f.resource("xml-v26"), "utf8");
  assert.doesNotMatch(raw, /@raw|src="user"|certificateTransparency|overridePins/);
});

test("only the verified root is copied if the source has an extra PEM block", async (t) => {
  const f = await fixture(t);
  const source = path.join(__dirname, "certificates", "isrg_root_x1.pem");
  const read = fs.readFileSync;
  const pem = read(source);
  t.mock.method(fs, "readFileSync", (file, ...args) =>
    file === source ? Buffer.concat([pem, pem]) : read(file, ...args),
  );
  await f.runResources();
  const generated = read(f.resource("raw", "kaata_isrg_root_x1.pem"), "utf8");
  assert.equal(generated.match(/BEGIN CERTIFICATE/g).length, 1);
  assert.equal(new X509Certificate(generated).fingerprint256, fingerprint);
});

test("preserves a build that disallows cleartext rather than enabling it", async (t) => {
  const f = await fixture(t, false);
  await f.runManifest();
  await f.runResources();
  for (const folder of ["xml", "xml-v26"]) {
    assert.equal((await f.xml(folder))["base-config"][0].$.cleartextTrafficPermitted, "false");
  }
});

test("refuses an unrelated manifest policy and inconsistent cleartext settings", async (t) => {
  const f = await fixture(t);
  f.application.$["android:networkSecurityConfig"] = "@xml/another_policy";
  await assert.rejects(f.runManifest, /another Android network security configuration/);
  assert.equal(f.application.$["android:networkSecurityConfig"], "@xml/another_policy");
  delete f.application.$["android:networkSecurityConfig"];
  f.application.$["android:usesCleartextTraffic"] = "false";
  await assert.rejects(f.runManifest, /cleartext policy differs/);
});

test("does not overwrite an unrelated resource or partially write before rejecting it", async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(path.dirname(f.resource("xml-v26")), { recursive: true });
  const original = "<network-security-config />";
  fs.writeFileSync(f.resource("xml-v26"), original);
  await assert.rejects(f.runResources, /Refusing to replace an existing/);
  assert.equal(fs.readFileSync(f.resource("xml-v26"), "utf8"), original);
  assert.equal(fs.existsSync(f.resource("xml")), false);
});

test("repeated prebuilds retain identical policy and root resources", async (t) => {
  const f = await fixture(t);
  await f.runManifest();
  await f.runResources();
  const paths = [
    f.resource("xml"),
    f.resource("xml-v26"),
    f.resource("raw", "kaata_isrg_root_x1.pem"),
  ];
  const first = paths.map((file) => fs.readFileSync(file));
  await f.runManifest();
  await f.runResources();
  paths.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), first[index]));
});
