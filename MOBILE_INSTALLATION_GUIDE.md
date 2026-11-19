# Install e-wallet on Android or iPhone without publishing

This guide covers installing your own development build directly on a phone. No Play Store or App Store listing is required. Run commands from the repository root unless a step says otherwise. Shell examples use Bash.

**Current status:** this is a local-chain/testnet early-access build. Real funds are disabled. Android APK compilation and both native JavaScript bundles passed; physical-device acceptance and the iOS executable have not been verified. The Android emulator remained ADB-offline during our check. See [verification](artifacts/product/verification.json) and [device acceptance](artifacts/product/device-acceptance.json).

## 1. Know which application you are opening

- **Wallet:** <http://127.0.0.1:5173> — the dark wallet interface.
- **Developer reference dapp:** <http://127.0.0.1:5174> — connection/signing test controls, a separate application.
- **Backend and built wallet approval windows:** <http://127.0.0.1:8787>.
- **Metro:** port **8081** — serves JavaScript to native debug builds.

The screenshot showing a populated wallet uses mock/sample balances. The actual wallet has the same styling, but starts with create/restore and displays observed chain balances. To preview sample data, run `pnpm dev:ui` instead of the regular wallet dev server; both use port 5173, so stop one before starting the other.

## 2. Prepare the repository and backend

Install pnpm **10.34.9**. The workspace automatically selects Node **24.22.3**. Android builds need Android Studio/SDK Platform Tools and a complete JDK; JDK 17 was used for the verified build. iPhone builds need a Mac, Xcode and CocoaPods. Native compilation downloads additional SDK components; running it separately from the chain browser suites uses less memory.

```bash
pnpm node --version
pnpm install --frozen-lockfile
```

For the local dataset, install/start Docker and run:

```bash
pnpm preflight
pnpm infra:up
pnpm seed:local
pnpm dev
```

Keep that terminal running. The phone needs the backend for network reads and transaction broadcasts. Installing an APK/IPA does not install the backend or blockchain nodes onto the phone.

For a populated local demonstration, fixture recovery information is generated under ignored `.local/secrets/`. These are deliberately public, insecure test identities. Use only test wallets; never import a recovery phrase that controls real funds.

## 3. Android: install over USB

### Connect the phone

Enable Developer options and USB debugging on the phone, connect it with a data-capable USB cable, and approve the computer's debugging authorization. Confirm that Android SDK Platform Tools are on your PATH. Google's [ADB guide](https://developer.android.com/tools/adb) documents device connection and installation.

```bash
adb devices
```

Continue when the phone appears as `device`. `unauthorized` means approval is pending; `offline` does not indicate a usable connection. With multiple devices, use `adb -s YOUR_DEVICE_SERIAL ...` for each ADB command below.

### Connect the phone to the local services

```bash
adb reverse tcp:8787 tcp:8787
adb reverse tcp:8081 tcp:8081
```

These routes let the phone use `http://127.0.0.1:8787` for this project's API and port 8081 for Metro. They may need to be recreated after reconnecting the phone. They do not expose your computer to the public internet.

### Build and install

Choose one path:

**Build for the selected phone and launch:**

```bash
pnpm --filter @ewallet/mobile exec expo run:android --device
```

Select your physical phone when prompted. Expo's [local compilation guide](https://docs.expo.dev/guides/local-app-development/) explains this device-selection flow. The command also starts Metro; do not start a second Metro on the same port.

**Build an APK first, then install it explicitly:**

```bash
pnpm mobile:build:android
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n app.ewallet.wallet/.MainActivity
```

In another terminal, start Metro if it is not already running:

```bash
pnpm mobile
```

On this workspace, a copy of the verified debug APK also exists at `.local/releases/e-wallet-0.2.0-debug.apk`. Generated APKs are not guaranteed to exist in a fresh checkout; build one there first.

**The debug APK requires Metro.** Copying it to a phone does not make it a standalone release. You can also open the APK from the phone's file manager after allowing installation from that source, but the API and Metro must still be reachable. An `.aab` is not the directly installable APK used by these commands. See [Expo APK installation](https://docs.expo.dev/build-reference/apk/).

## 4. iPhone: install directly from Xcode

### Prepare the Mac and phone

You need a Mac with compatible Xcode, CocoaPods, an Apple Account and a connected iPhone. Unlock the phone, trust the Mac, and enable Developer Mode when prompted. Apple describes device pairing and selecting a run destination in its [Xcode device guide](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices).

A free Apple Account can use an Xcode **Personal Team** for personal-device testing. Its provisioning expires after seven days, requiring rebuilding/reinstalling. This is not a distribution route for arbitrary clients. Apple's [account overview](https://developer.apple.com/help/account/basics/about-your-developer-account) lists the current limits. No App Store submission is needed for this workflow.

### Configure an API reachable by the iPhone

The phone's `127.0.0.1` refers to the phone, not your Mac. The Android `adb reverse` instructions do not apply to iOS. This project's native API client also rejects ordinary `http://192.168.x.x` backend URLs.

Use an HTTPS API you control, or a development HTTPS proxy with a certificate trusted by the phone. Set an **origin only**, without an `/api` path:

```bash
export EXPO_PUBLIC_API_URL="https://wallet-dev.your-domain.example"
```

Replace that example with a working address. On the backend host, include that exact HTTPS origin in `EWALLET_PUBLIC_ORIGINS`. The reverse proxy must preserve the public Host header. For example, with a local HTTPS proxy forwarding to the existing local-chain backend:

```bash
EWALLET_PUBLIC_ORIGINS="https://wallet-dev.your-domain.example,http://127.0.0.1:8787,http://127.0.0.1:5173" pnpm dev
```

Stop the previous `pnpm dev` process before restarting it with the new origin configuration; environment changes do not reconfigure an already running backend.

Set up the proxy/certificate separately; the command above does not create one. [The deployment configuration](infra/deployment/) provides an HTTPS option for a host with a domain. Do not change the native client's HTTPS checks or expose node administration ports as a workaround.

### Install native dependencies and set signing

On the Mac, with dependencies already installed:

```bash
pod install --project-directory=apps/mobile/ios
open apps/mobile/ios/ewallet.xcworkspace
```

If native project files need regeneration, first preserve any native edits and run `pnpm --filter @ewallet/mobile exec expo prebuild --platform ios --no-install`, then run `pod install` again. Avoid `--clean` unless you intend to regenerate the native project.

In Xcode:

1. Open the **ewallet** app target, then **Signing & Capabilities**.
2. Enable automatic signing and choose your Personal Team or development team.
3. If the default bundle identifier cannot be provisioned, choose one unique to you. Also update `ios.bundleIdentifier` in `apps/mobile/app.config.ts` so later regeneration preserves it.
4. Select the **ewallet** scheme and your connected iPhone as the run destination.
5. Build and run. Resolve any signing or Developer Mode prompts shown by Xcode/the phone.

After signing is configured, the equivalent device-selection CLI entry is:

```bash
pnpm --filter @ewallet/mobile exec expo run:ios --device
```

For debug JavaScript updates over Wi-Fi, keep Mac and phone on the same reachable network and start Metro using:

```bash
pnpm --filter @ewallet/mobile exec expo start --lan --port 8081
```

Use that command **instead of** `pnpm mobile`, whose localhost binding is intended for the Android USB workflow. Allow the phone to reach port 8081 through the Mac firewall. If the installed debug app cannot locate Metro, configure its development server host using the Mac's LAN address and port 8081. The app's API continues to use the separately configured HTTPS URL.

## 5. Run without Metro, still without a public store listing

Debug installation and standalone installation are different. Both can avoid public stores, but standalone builds need embedded JavaScript and valid signing. Backend connectivity is still required for network features.

### Android standalone APK

For an internal build, use your own keystore and a reachable HTTPS API. Generate a key outside the repository; `keytool` prompts for its passwords and certificate details:

```bash
mkdir -p "$HOME/.local/share/e-wallet-signing"
keytool -genkeypair -v -keystore "$HOME/.local/share/e-wallet-signing/internal-release.jks" -alias ewallet-internal -keyalg RSA -keysize 3072 -validity 3650
```

Keep the key and passwords safe: you need the same signing identity to update this installation. Supply the existing Gradle guard's required environment variables:

- `EWALLET_ANDROID_KEYSTORE`: absolute keystore path.
- `EWALLET_ANDROID_KEYSTORE_PASSWORD`, `EWALLET_ANDROID_KEY_ALIAS`, `EWALLET_ANDROID_KEY_PASSWORD`: your signing values.
- `EWALLET_MOBILE_RELEASE=1`.
- `EXPO_PUBLIC_API_URL`: your working HTTPS API origin.

Load passwords through your local secret-management process; do not commit them or put their literal values into shared shell scripts. Then:

```bash
pnpm --filter @ewallet/mobile exec expo run:android --variant release --device
```

The release variant embeds JavaScript and uses the configured release signing key. Its usual APK location is `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`; it can be installed with `adb install -r`. This release variant has **not** been verified in this workspace. The already verified package is debug only. Switching between debug and release signing may prevent in-place installation; preserve recovery information before choosing to remove an existing installation. Expo documents [local release builds](https://docs.expo.dev/guides/local-app-production/).

`EWALLET_MOBILE_RELEASE=1` selects release configuration; it does **not** enable real funds or satisfy the security/release gates.

### iPhone standalone development build

In Xcode, edit the scheme's **Run** configuration to **Release**, keep development signing configured for your phone, and build/run on it. This embeds the JavaScript bundle, so Metro is unnecessary. Your HTTPS backend remains necessary. Personal Team expiry still applies; a Release configuration does not remove provisioning requirements.

For private testing on additional registered devices, a team enrolled in the Apple Developer Program can use an appropriate development/ad hoc provisioning workflow. A properly signed IPA and a matching device profile are required; an unsigned `.app` from the simulator workflow cannot be installed on an iPhone. This repository's GitHub workflow currently builds an **unsigned simulator app**, not a distributable phone IPA. See Apple's [device distribution guide](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices).

## 6. Troubleshooting

- **Light developer page instead of dark wallet:** use port **5173**, not **5174**.
- **Android app cannot load JavaScript:** start Metro, recreate the two `adb reverse` routes, and check `adb devices`.
- **iPhone app cannot load JavaScript:** use Metro's LAN binding, correct development server host, same reachable network and firewall access.
- **Balances/API fail while the app opens:** check the API URL, HTTPS trust, backend Host allowlist and `/api/v1/health`. A functioning Metro server does not imply a functioning backend.
- **`JAVA_HOME` error:** point it at a full JDK containing `bin/javac`, not just a Java runtime.
- **APK update rejected:** check application ID and signing certificate. Do not automatically uninstall a wallet containing an unrecovered phrase.
- **iPhone signing error:** check Team, identifier, connected-device eligibility and provisioning in Xcode. Reprovision expired Personal Team builds.
- **API address or native configuration changed:** restart Metro and rebuild/reinstall the native app so its configuration is refreshed.
- **Need an Expo Go shortcut:** use this project's own native build for acceptance testing; Expo Go does not validate this app's generated native security configuration.

## 7. Is all the work complete?

**No. The implemented early-access build is not the completed production/Phantom-parity scope.**

Completed evidence includes the redesigned web UI, native Android/iOS source, Android debug APK, both native bundles, 70 passing unit tests, web multichain browser flows and native signing-core chain proofs.

Still outstanding: physical-device acceptance, iOS executable verification/signing, native external dapp protocols, biometric unlock, independent security review, mainnet adapters/indexing and isolated mainnet vaults, and client deployment/distribution setup. One-click mainnet activation is not implemented. Public-testnet funding blockers remain separate from successful local-chain tests.

Use [the current verification report](artifacts/product/verification.json), [release checks](artifacts/product/release-readiness.json) and `pnpm release:check` for the exact limitations. Installing privately does not make those checks complete.
