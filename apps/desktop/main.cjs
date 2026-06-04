const { app, BrowserWindow, dialog, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { pathToFileURL } = require("node:url");

const APP_NAME = "Star Companion";

let mainWindow = null;

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

const ensureMigrationTable = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL,
      "checksum" TEXT NOT NULL,
      "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL,
      "logs" TEXT,
      "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
    )
  `);
};

const hasExistingAppTables = (db) =>
  Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('UserSettings', 'Character', 'Chat', 'Message') LIMIT 1"
      )
      .get()
  );

const readAppliedMigrations = (db) =>
  new Set(
    db
      .prepare(
        'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL'
      )
      .all()
      .map((row) => row.migration_name)
  );

const recordMigration = (db, migrationName, sql) => {
  const now = new Date().toISOString();
  const checksum = crypto.createHash("sha256").update(sql).digest("hex");

  db.prepare(`
    INSERT INTO "_prisma_migrations" (
      "id",
      "checksum",
      "finished_at",
      "migration_name",
      "logs",
      "rolled_back_at",
      "started_at",
      "applied_steps_count"
    )
    VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)
  `).run(crypto.randomUUID(), checksum, now, migrationName, now);
};

const runDesktopMigrations = (serverDir, databasePath) => {
  const migrationsDir = path.join(serverDir, "prisma", "migrations");
  const db = new DatabaseSync(databasePath);

  try {
    ensureMigrationTable(db);

    const migrationNames = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const applied = readAppliedMigrations(db);

    if (applied.size === 0 && hasExistingAppTables(db)) {
      for (const migrationName of migrationNames) {
        const sql = fs.readFileSync(path.join(migrationsDir, migrationName, "migration.sql"), "utf8");
        recordMigration(db, migrationName, sql);
      }
      return;
    }

    for (const migrationName of migrationNames) {
      if (applied.has(migrationName)) {
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, migrationName, "migration.sql"), "utf8");
      db.exec(sql);
      recordMigration(db, migrationName, sql);
    }
  } finally {
    db.close();
  }
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
  writeStartupLog(`serverDir=${serverDir}`);
  writeStartupLog(`webDistDir=${webDistDir}`);
  writeStartupLog(`appData=${app.getPath("appData")}`);
  writeStartupLog(`dataDir=${dataDir}`);

  const port = await getAvailablePort();
  const databasePath = path.join(dataDir, "star-companion.db");
  const databaseUrl = `file:${toPosixPath(databasePath)}`;

  process.env.DATABASE_URL = databaseUrl;
  process.env.SERVER_PORT = String(port);
  process.env.CORS_ORIGIN = `http://127.0.0.1:${port}`;
  process.env.WEB_DIST_DIR = webDistDir;
  process.env.API_KEY_ENCRYPTION_SECRET = ensureDesktopSecret(dataDir);

  runDesktopMigrations(serverDir, databasePath);
  await import(pathToFileURL(path.join(serverDir, "dist", "index.js")).href);
  await waitForHealth(port);

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
      sandbox: true
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

app.whenReady().then(async () => {
  try {
    const port = await startServer();
    await createWindow(port);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStartupLog(`error=${message}`);
    dialog.showErrorBox(`${APP_NAME} failed to start`, message);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
