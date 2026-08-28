import { execFileSync } from "node:child_process";
import { join } from "node:path";

if (process.env.ELECTROBUN_OS === "macos") {
  const bundle = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
  if (!bundle) throw new Error("ELECTROBUN_WRAPPER_BUNDLE_PATH is not set");

  const infoPlist = join(bundle, "Contents", "Info.plist");
  const usageDescriptions = {
    NSCameraUsageDescription:
      "Camera required for uploading photos and video calls",
    NSMicrophoneUsageDescription: "Microphone required for video calls",
  };

  for (const [key, value] of Object.entries(usageDescriptions)) {
    execFileSync(
      "/usr/bin/plutil",
      ["-replace", key, "-string", value, infoPlist],
      { stdio: "inherit" },
    );
  }
}
