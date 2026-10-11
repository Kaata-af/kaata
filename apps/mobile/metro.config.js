const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);

// This repository installs app dependencies separately rather than declaring
// package workspaces, so Expo cannot discover the sibling shared directory.
// Include it in Metro's file map for the canonical palette JSON import.
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, "../_shared")];

module.exports = config;
