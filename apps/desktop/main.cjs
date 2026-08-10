const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { autoUpdater } = require("electron-updater");
const { restoreSafetyCopy, runProtectedMigrations } = require("./migration-safety.cjs");
const {
  classifyUpdateError,
  createInitialUpdateState,
  reduceUpdateState
} = require("./update-state.cjs");

const APP_NAME = "Star Companion";
const readDesktopBuildType = () => {
  if (!app.isPackaged) return "development";
  try {
    const packageMetadata = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
    return packageMetadata.starCompanionBuildType === "release" ? "release" : "preview";
  } catch {
    return "preview";
  }
};
const DESKTOP_BUILD_TYPE = readDesktopBuildType();

let mainWindow = null;
let updateState = createInitialUpdateState({
  enabled: DESKTOP_BUILD_TYPE === "release" && process.platform === "win32",
  disabledReason: DESKTOP_BUILD_TYPE === "release" ? "unsupported_platform" : "development_build",
  currentVersion: app.getVersion()
});

const writeStartupLog = (message) => {
  if (!process.env.DESKTOP_STARTUP_LOG) {
    return;
  }

  fs.appendFileSync(
    process.env.DESKTOP_STARTUP_LOG,
    `[${new Date().toISOString()}] ${message}\n`,
    "utf8"
  );
};

const toPosixPath = (value) => value.replace(/\\/g, "/");

const getResourcePath = (...segments) => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments);
  }

  return path.join(__dirname, "..", ...segments);
};

const getAppIconPath = () =>
  path.join(__dirname, "assets", process.platform === "win32" ? "app-icon.ico" : "app-icon.png");

const getAvailablePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const ensureDesktopSecret = (dataDir) => {
  const secretPath = path.join(dataDir, "api-key-secret.txt");

  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, "utf8").trim();
  }

  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(secretPath, secret, { encoding: "utf8", flag: "wx" });
  return secret;
};

const safeErrorCode = (error) => typeof error?.code === "string" ? error.code : error?.name || "STARTUP_FAILED";

const updatePublicState = (event) => {
  updateState = reduceUpdateState(updateState, event);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("updates:state", updateState);
  }
  return updateState;
};

const configureUpdates = () => {
  ipcMain.handle("updates:get-state", () => updateState);
  ipcMain.handle("updates:check", async () => {
    if (updateState.status === "disabled") return updateState;
    updatePublicState({ type: "check_started" });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      if (updateState.status !== "error") updatePublicState({ type: "error", code: classifyUpdateError(error, "checking") });
    }
    return updateState;
  });
  ipcMain.handle("updates:download", async () => {
    if (updateState.status !== "available") return updateState;
    updatePublicState({ type: "download_started" });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      if (updateState.status !== "error") updatePublicState({ type: "error", code: classifyUpdateError(error, "downloading") });
    }
    return updateState;
  });
  ipcMain.handle("updates:defer", () => updatePublicState({ type: "deferred" }));
  ipcMain.handle("updates:install", () => {
    if (!['downloaded', 'deferred'].includes(updateState.status) || updateState.progressPercent !== 100) return updateState;
    updatePublicState({ type: "install_confirmed" });
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return updateState;
  });

  if (updateState.status === "disabled") return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("update-available", (info) => updatePublicState({ type: "update_available", version: info.version, releaseNotes: info.releaseNotes }));
  autoUpdater.on("update-not-available", () => updatePublicState({ type: "update_not_available" }));
  autoUpdater.on("download-progress", (progress) => updatePublicState({
    type: "download_progress",
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total
  }));
  autoUpdater.on("update-downloaded", (info) => updatePublicState({ type: "downloaded", version: info.version }));
  autoUpdater.on("error", (error) => updatePublicState({
    type: "error",
    code: classifyUpdateError(error, updateState.status === "downloading" ? "downloading" : "checking")
  }));
};

const waitForHealth = (port) =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const check = () => {
      const request = http.get(`http://127.0.0.1:${port}/api/health`, (response) => {
        response.resume();

        if (response.statusCode === 200) {
          resolve();
          return;
        }

        retry();
      });

      request.on("error", retry);
      request.setTimeout(1000, () => {
        request.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startedAt > 30000) {
        reject(new Error("Timed out waiting for the local server to start."));
        return;
      }

      setTimeout(check, 250);
    };

    check();
  });

const startServer = async () => {
  const serverDir = getResourcePath("server");
  const webDistDir = getResourcePath("web");
  const dataDir =
    process.env.STAR_COMPANION_DATA_DIR || path.join(app.getPath("appData"), "StarCompanion");

  fs.mkdirSync(dataDir, { recursive: true });
  writeStartupLog("resourcesResolved=true");

  const port = await getAvailablePort();
  const databasePath = path.join(dataDir, "star-companion.db");
  const databaseUrl = `file:${toPosixPath(databasePath)}`;

  process.env.DATABASE_URL = databaseUrl;
  process.env.SERVER_PORT = String(port);
  process.env.CORS_ORIGIN = `http://127.0.0.1:${port}`;
  process.env.WEB_DIST_DIR = webDistDir;
  process.env.API_KEY_ENCRYPTION_SECRET = ensureDesktopSecret(dataDir);
  process.env.STAR_COMPANION_APP_VERSION = app.getVersion();
  process.env.STAR_COMPANION_PLATFORM = "windows";
  process.env.STAR_COMPANION_BUILD_TYPE = DESKTOP_BUILD_TYPE;

  const migrationReport = runProtectedMigrations({
    databasePath,
    migrationsDirectory: path.join(serverDir, "prisma", "migrations"),
    recoveryDirectory: path.join(dataDir, "upgrade-recovery"),
    appVersion: app.getVersion()
  });
  process.env.STAR_COMPANION_MIGRATION_REPORT = JSON.stringify({
    status: migrationReport.recoveryCreated || (migrationReport.previousAppVersion && migrationReport.previousAppVersion !== app.getVersion()) ? "upgraded" : "ready",
    previousAppVersion: migrationReport.previousAppVersion,
    previousSchemaVersion: migrationReport.previousSchemaVersion,
    appliedMigrations: migrationReport.appliedMigrations,
    recoveryCreated: migrationReport.recoveryCreated
  });
  writeStartupLog(`migrationStatus=${migrationReport.recoveryCreated ? "upgraded_with_recovery" : "ready"}`);
  await import(pathToFileURL(path.join(serverDir, "dist", "index.js")).href);
  await waitForHealth(port);
  writeStartupLog("serverReady=true");

  return port;
};

const createWindow = async (port) => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    icon: getAppIconPath(),
    backgroundColor: "#09090b",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
};

app.setName(APP_NAME);
app.setAppUserModelId("local.star-companion.app");
configureUpdates();

app.whenReady().then(async () => {
  try {
    const port = await startServer();
    await createWindow(port);
  } catch (error) {
    const code = safeErrorCode(error);
    writeStartupLog(`startupError=${code}`);
    const dataDir = process.env.STAR_COMPANION_DATA_DIR || path.join(app.getPath("appData"), "StarCompanion");
    const recoveryDirectory = path.join(dataDir, "upgrade-recovery");
    const latestRecoveryId = fs.existsSync(recoveryDirectory)
      ? fs.readdirSync(recoveryDirectory).filter((name) => name.endsWith(".json")).sort().at(-1)?.replace(/\.json$/, "") || null
      : null;
    const buttons = latestRecoveryId ? ["Close", "Open recovery folder", "Restore latest safety copy"] : ["Close", "Open recovery folder"];
    const choice = dialog.showMessageBoxSync({
      type: "error",
      title: `${APP_NAME} failed to start`,
      message: code === "SCHEMA_TOO_NEW" || code === "APP_TOO_OLD"
        ? "This data belongs to a newer Star Companion version. Update the app before trying again."
        : "Star Companion could not safely upgrade the local database. The original database was not deleted.",
      detail: `Diagnostic code: ${code}. You can open the recovery folder and keep it for support.`,
      buttons,
      defaultId: 0,
      cancelId: 0
    });
    if (choice === 1) {
      fs.mkdirSync(recoveryDirectory, { recursive: true });
      await shell.openPath(recoveryDirectory);
    } else if (choice === 2 && latestRecoveryId) {
      const confirmed = dialog.showMessageBoxSync({
        type: "warning",
        title: "Restore pre-upgrade database",
        message: "Replace the current database with the latest pre-upgrade safety copy?",
        detail: "The app will remain closed after restoring. Install the previous compatible version or contact support before opening it again.",
        buttons: ["Cancel", "Restore safety copy"],
        defaultId: 0,
        cancelId: 0
      });
      if (confirmed === 1) {
        try {
          restoreSafetyCopy({ databasePath: path.join(dataDir, "star-companion.db"), recoveryDirectory, recoveryId: latestRecoveryId });
          dialog.showMessageBoxSync({ type: "info", title: "Database restored", message: "The pre-upgrade database was restored.", buttons: ["Close"] });
        } catch {
          dialog.showMessageBoxSync({ type: "error", title: "Restore failed", message: "The recovery copy could not be restored. The existing database was preserved.", buttons: ["Close"] });
        }
      }
    }
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
