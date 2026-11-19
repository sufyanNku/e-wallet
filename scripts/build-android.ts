import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Android", "Sdk");
if (!existsSync(sdk))
  throw new Error("Set ANDROID_HOME to your Android SDK directory.");
if (
  process.env.JAVA_HOME &&
  !existsSync(
    join(
      process.env.JAVA_HOME,
      "bin",
      process.platform === "win32" ? "javac.exe" : "javac",
    ),
  )
)
  throw new Error(
    "JAVA_HOME must point to a complete JDK with javac, not a JRE.",
  );
await new Promise<void>((resolve, reject) => {
  const child = spawn(
    process.platform === "win32" ? "gradlew.bat" : "./gradlew",
    [
      "assembleDebug",
      "--no-daemon",
      "--max-workers=1",
      "-Pkotlin.compiler.execution.strategy=in-process",
      "-PreactNativeArchitectures=arm64-v8a,x86_64",
    ],
    {
      cwd: "apps/mobile/android",
      stdio: "inherit",
      env: {
        ...process.env,
        ANDROID_HOME: sdk,
        CMAKE_BUILD_PARALLEL_LEVEL: "1",
      },
    },
  );
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0
      ? resolve()
      : reject(new Error("Android build failed. See the Gradle error above.")),
  );
});
console.log(
  "Debug APK: apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk",
);
