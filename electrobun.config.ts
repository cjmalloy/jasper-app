import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Jasper",
    identifier: "com.cjmalloy.jasper",
    version: "1.1.23",
    description: "Desktop app for Jasper KM",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/main/index.ts",
    },
    views: {
      bridge: {
        entrypoint: "src/views/bridge.ts",
        format: "iife",
      },
    },
    copy: {
      "loading.html": "views/loading/index.html",
      "logs.html": "views/logs/index.html",
      "settings.html": "views/settings/index.html",
      "app.png": "views/assets/app.png",
      "jasper-dark.png": "views/assets/jasper-dark.png",
      "docker-compose.yaml": "views/assets/docker-compose.yaml",
      "node_modules/@xterm/xterm/css/xterm.css": "views/assets/xterm.css",
      "node_modules/@xterm/xterm/lib/xterm.js": "views/assets/xterm.js",
      "node_modules/@xterm/addon-fit/lib/addon-fit.js": "views/assets/addon-fit.js",
      "node_modules/jquery/dist/jquery.min.js": "views/assets/jquery.js",
    },
    buildFolder: "dist",
    artifactFolder: "release",
    mac: {
      bundleCEF: false,
      codesign: false,
      createDmg: true,
      entitlements: {
        "com.apple.security.device.audio-input": true,
        "com.apple.security.device.camera": true,
      },
    },
    linux: {
      bundleCEF: false,
      icon: "build/icon.png",
    },
    win: {
      bundleCEF: false,
      icon: "build/icon.png",
      autoGrantPermissions: ["camera", "microphone"],
    },
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
  release: {
    baseUrl:
      "https://github.com/cjmalloy/jasper-app/releases/latest/download",
  },
  scripts: {
    postWrap: "scripts/post-wrap.ts",
  },
} satisfies ElectrobunConfig;
