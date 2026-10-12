// apps/mobile/plugins/withNeutralAndroidAccent.js
//
// The in-app UI is black, white and grey (Matee, request #12). Android
// widgets the app does not draw itself (the reminder date and time dialogs,
// text cursors and selection handles, some spinners) take the theme's
// colorPrimary and colorAccent. Expo defaults colorPrimary to navy (#023c69)
// and AppCompat's accent is teal, so those widgets were the last
// off-palette colour in the app (audit #12). Both become the app's black.
// Takes effect only with the next native build; JS updates cannot change a
// theme.

const { AndroidConfig, withAndroidColors, withAndroidStyles } = require("@expo/config-plugins");

const BLACK = "#000000";

module.exports = function withNeutralAndroidAccent(config) {
  // colorPrimary: Expo's own primaryColor mod writes it from this key.
  config.primaryColor = BLACK;
  config = withAndroidColors(config, (cfg) => {
    cfg.modResults = AndroidConfig.Colors.assignColorValue(cfg.modResults, {
      name: "colorAccent",
      value: BLACK,
    });
    return cfg;
  });
  config = withAndroidStyles(config, (cfg) => {
    cfg.modResults = AndroidConfig.Styles.assignStylesValue(cfg.modResults, {
      add: true,
      parent: AndroidConfig.Styles.getAppThemeGroup(),
      name: "colorAccent",
      value: "@color/colorAccent",
    });
    return cfg;
  });
  return config;
};
