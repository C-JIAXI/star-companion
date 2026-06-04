import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "local.starcompanion.app",
  appName: "Star Companion",
  webDir: "apps/web/dist",
  server: {
    androidScheme: "https",
    cleartext: true
  },
  plugins: {
    CapacitorNodeJS: {
      nodeDir: "nodejs",
      startMode: "auto"
    }
  }
};

export default config;
