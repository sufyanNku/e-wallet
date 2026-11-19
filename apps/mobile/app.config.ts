import type { ExpoConfig } from "expo/config";
const api = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:8787";
const release = process.env.EWALLET_MOBILE_RELEASE === "1";
if (release && !api.startsWith("https://"))
  throw new Error("Mobile release builds require an HTTPS API.");
const config: ExpoConfig = {
  name: "e-wallet",
  slug: "e-wallet",
  version: "0.2.0",
  scheme: "ewallet",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  backgroundColor: "#141318",
  icon: "./assets/icon.png",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "app.ewallet.wallet",
    infoPlist: {
      NSFaceIDUsageDescription: "Use Face ID to protect access to your wallet.",
    },
  },
  android: {
    package: "app.ewallet.wallet",
    allowBackup: false,
    permissions: ["CAMERA"],
    blockedPermissions: [
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.RECORD_AUDIO",
    ],
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#141318",
    },
  },
  plugins: [
    "./plugins/with-wallet-security.cjs",
    [
      "expo-secure-store",
      {
        configureAndroidBackup: true,
        faceIDPermission: "Protect access to your wallet with Face ID.",
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission: "Scan a wallet address or payment QR code.",
        recordAudioAndroid: false,
      },
    ],
    ["expo-build-properties", { android: { usesCleartextTraffic: !release } }],
  ],
  extra: { apiUrl: api, realFundsEnabled: false },
  updates: { enabled: false },
  web: { bundler: "metro", output: "single", favicon: "./assets/icon.png" },
};
export default config;
