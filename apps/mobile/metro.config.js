const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");
const { limitCacheStores } = require("./scripts/metro-cache-limit.cjs");

const config = getDefaultConfig(__dirname);

// This repository installs app dependencies separately rather than declaring
// package workspaces, so Expo cannot discover the sibling shared directory.
// Include it in Metro's file map for the canonical palette JSON import.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, "../_shared")];

// Keep transformer file handles in separate processes on Windows. Worker
// threads share Metro's handle table, which can exhaust it during HMR.
if (process.platform === "win32") {
  // Async graphs share the transform cache independently of worker count.
  // Bound cache reads/writes together to avoid exhausting Windows handles.
  config.cacheStores = limitCacheStores(config.cacheStores, 32);
  config.maxWorkers = 2;
  config.transformer.unstable_workerThreads = false;
  // Hash changes in the bounded crawl/watch queue before HMR rebuilds graphs,
  // instead of opening the same source concurrently from lazy SHA requests.
  config.watcher.unstable_lazySha1 = false;
}

// These generated trees contain thousands of directories. Metro's Windows
// fallback watcher watches each directory, even when its files are gitignored.
// Keep Expo's dev/runtime directories and all app/shared sources available.
const generatedDirectories = [
  "dist",
  "android/.gradle",
  "android/.kotlin",
  "android/build",
  "android/app/.cxx",
  "android/app/build",
  ".expo/phone-review",
  ".expo/release-45-25",
  ".expo/selection-build-temp",
  ".expo/snapshots",
];
const generatedBlockList = generatedDirectories.map((directory) => {
  const absolutePath = path
    .resolve(__dirname, directory)
    .split(path.sep)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]");
  return new RegExp(`^${absolutePath}(?:[\\\\/]|$)`);
});
const defaultBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(defaultBlockList)
    ? defaultBlockList
    : defaultBlockList
      ? [defaultBlockList]
      : []),
  ...generatedBlockList,
];

module.exports = config;
