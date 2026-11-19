/* global require, module */
// Expo config plugins execute in Node using CommonJS.
/* eslint-disable @typescript-eslint/no-require-imports -- Expo loads config plugins as CommonJS. */
const {
  withAppBuildGradle,
  withInfoPlist,
  withMainActivity,
  withDangerousMod,
} = require("expo/config-plugins");
module.exports = function withWalletSecurity(config) {
  config = withInfoPlist(config, (c) => {
    delete c.modResults.ITSAppUsesNonExemptEncryption;
    return c;
  });
  config = withMainActivity(config, (c) => {
    if (!c.modResults.contents.includes("override fun onPause()"))
      c.modResults.contents = c.modResults.contents
        .replace(
          "import android.os.Bundle",
          "import android.os.Bundle\nimport android.view.WindowManager",
        )
        .replace(
          "class MainActivity : ReactActivity() {",
          `class MainActivity : ReactActivity() {
  override fun onPause() {
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    super.onPause()
  }
`,
        );
    return c;
  });
  config = withDangerousMod(config, [
    "ios",
    async (c) => {
      // Preserve the reviewed SceneDelegate implementation when regenerating projects.
        const fs = require("node:fs/promises");
        const path = require("node:path");
      const source = path.join(
        c.modRequest.projectRoot,
        "plugins",
        "SceneDelegate.swift",
      );
      await fs.copyFile(
        source,
        path.join(
          c.modRequest.platformProjectRoot,
          "ewallet",
          "SceneDelegate.swift",
        ),
      );
      return c;
    },
  ]);
  return withAppBuildGradle(config, (c) => {
    let source = c.modResults.contents;
    if (!source.includes("// e-wallet release signing guard")) {
      source = source.replace(
        "signingConfigs {",
        `signingConfigs {
        if (System.getenv('EWALLET_ANDROID_KEYSTORE')) {
            release {
                storeFile file(System.getenv('EWALLET_ANDROID_KEYSTORE'))
                storePassword System.getenv('EWALLET_ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('EWALLET_ANDROID_KEY_ALIAS')
                keyPassword System.getenv('EWALLET_ANDROID_KEY_PASSWORD')
            }
        }`,
      );
      source = source.replace(
        /(release\s*\{[\s\S]*?)signingConfig signingConfigs.debug/,
        "$1if (System.getenv('EWALLET_ANDROID_KEYSTORE')) signingConfig signingConfigs.release",
      );
      source += `\n// e-wallet release signing guard
gradle.taskGraph.whenReady { graph ->
    if (graph.allTasks.any { it.name.toLowerCase().contains('release') }) {
        ['EWALLET_ANDROID_KEYSTORE','EWALLET_ANDROID_KEYSTORE_PASSWORD','EWALLET_ANDROID_KEY_ALIAS','EWALLET_ANDROID_KEY_PASSWORD'].each { name ->
            if (!System.getenv(name)) throw new GradleException('Release signing is not configured: ' + name)
        }
        if (System.getenv('EWALLET_MOBILE_RELEASE') != '1' || !(System.getenv('EXPO_PUBLIC_API_URL') ?: '').startsWith('https://'))
            throw new GradleException('Release builds require EWALLET_MOBILE_RELEASE=1 and an HTTPS EXPO_PUBLIC_API_URL')
    }
}
`;
    }
    c.modResults.contents = source;
    return c;
  });
};
