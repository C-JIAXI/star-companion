const packageJson = require("./package.json");

const repository = new URL(packageJson.repository.url);
const [owner, repoWithSuffix] = repository.pathname.replace(/^\//, "").split("/");
const githubPublish = { provider: "github", owner, repo: repoWithSuffix.replace(/\.git$/, "") };
const genericUrl = process.env.STAR_COMPANION_UPDATE_URL?.trim();
if (genericUrl && new URL(genericUrl).protocol !== "https:") {
  throw new Error("STAR_COMPANION_UPDATE_URL must use HTTPS.");
}

module.exports = {
  appId: "local.star-companion.app",
  productName: "Star Companion",
  extraMetadata: { starCompanionBuildType: "preview" },
  artifactName: "${productName}-Setup-${version}-${os}-${arch}.${ext}",
  directories: { output: "dist/desktop" },
  files: ["apps/desktop/**/*"],
  extraResources: [
    { from: "dist/desktop-resources/web", to: "web" },
    { from: "dist/desktop-resources/server/dist", to: "server/dist" },
    { from: "dist/desktop-resources/server/prisma", to: "server/prisma" },
    { from: "dist/desktop-resources/server/package.json", to: "server/package.json" },
    { from: "dist/desktop-resources/server/package-lock.json", to: "server/package-lock.json" },
    { from: "dist/desktop-resources/server/node_modules", to: "server/node_modules", filter: ["**/*"] }
  ],
  win: {
    icon: "apps/desktop/assets/app-icon.ico",
    signAndEditExecutable: false,
    target: ["nsis"]
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true
  },
  publish: genericUrl ? [{ provider: "generic", url: genericUrl }] : [githubPublish]
};
