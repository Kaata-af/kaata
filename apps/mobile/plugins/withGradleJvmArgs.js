// apps/mobile/plugins/withGradleJvmArgs.js
//
// Bumps Gradle's JVM heap + Metaspace at prebuild time.
//
// The Expo SDK 54 template ships android/gradle.properties with
//   org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=512m
// which is too tight for our build: KSP (expo-updates) and lintVitalAnalyze
// (expo-dev-menu, expo-modules-core) blow the metaspace and the build dies
// with three parallel OutOfMemoryError: Metaspace failures.
//
// android/ is regenerated every prebuild so manually editing the file is
// futile; this plugin rewrites the org.gradle.jvmargs line each time.
//
// Tune these if you're on a low-RAM machine — 8 GB heap assumes the dev
// machine has 16 GB+ system RAM. Lowest values that have built clean:
//   -Xmx6144m -XX:MaxMetaspaceSize=1024m

const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("@expo/config-plugins");

const JVM_ARGS = "-Xmx8192m -XX:MaxMetaspaceSize=2048m -Dfile.encoding=UTF-8";

module.exports = function withGradleJvmArgs(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const propsPath = path.join(cfg.modRequest.projectRoot, "android", "gradle.properties");
      try {
        let props = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, "utf8") : "";
        if (/^\s*org\.gradle\.jvmargs\s*=/m.test(props)) {
          props = props.replace(
            /^\s*org\.gradle\.jvmargs\s*=.*$/m,
            `org.gradle.jvmargs=${JVM_ARGS}`,
          );
        } else {
          props = `${props.replace(/\s*$/, "")}\norg.gradle.jvmargs=${JVM_ARGS}\n`;
        }
        fs.writeFileSync(propsPath, props, "utf8");
      } catch (err) {
        console.warn("[withGradleJvmArgs] failed to patch gradle.properties:", err?.message);
      }
      return cfg;
    },
  ]);
};
