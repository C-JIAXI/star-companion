import { CheckCircle2, Clipboard, Download, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppInfoDTO, AppLanguage } from "../types";
import { api } from "../lib/api";
import { Button, ConfirmDialog, ErrorNotice, Panel, SuccessNotice } from "./ui";

const panelClassName = "border-white/[0.08] bg-ink-900";
const surfaceClassName = "border border-white/[0.07] bg-ink-950/45";

const copyFor = (language: AppLanguage) => language === "zh-CN" ? {
  title: "关于与更新",
  help: "查看版本、构建来源和数据库迁移状态。桌面更新仅在正式 Windows 安装包中启用，不会自动下载或静默安装。",
  version: "应用版本",
  schema: "数据版本",
  platform: "平台",
  build: "构建类型",
  commit: "构建提交",
  migration: "数据迁移",
  check: "检查更新",
  checking: "正在检查…",
  download: "下载更新",
  install: "确认重启并安装",
  defer: "稍后处理",
  openStore: "前往安全更新来源",
  copyDiagnostics: "复制脱敏诊断信息",
  copied: "诊断信息已复制；不含 API Key、聊天正文、persona 或角色提示词。",
  recoveryNote: "安装新版本后，如需升级数据库，应用会先检查完整性并创建升级前安全副本。",
  noUpdate: "当前已是最新版本。",
  available: (version: string) => `发现版本 ${version}`,
  downloaded: "下载与校验已完成。请确认后重启安装。",
  deferred: "此次更新已推迟，可随时回来安装。",
  disabledDev: "开发或未打包构建已禁用真实更新检查。",
  disabledPlatform: "此平台不支持应用内安装更新。",
  migrationReady: "数据结构已就绪",
  migrationUpgraded: "本次启动已安全完成数据迁移",
  migrationUnknown: "无法确认数据迁移状态；请先运行版本对应的迁移检查",
  migrationFailed: "数据迁移失败；原数据库已保留。请保留 upgrade-recovery 副本并获取支持",
  migrationTooNew: "数据由更新版本创建；请先更新应用，不要继续写入",
  firstLaunch: (from: string | null, count: number) => `版本升级完成${from ? `（来自 ${from}）` : ""}；已应用 ${count} 个数据迁移。`,
  confirmTitle: "安装更新",
  confirmMessage: "应用将关闭并由已下载的安装包更新。升级数据库前会先创建安全副本。现在继续吗？",
  cancel: "取消",
  errors: {
    network_failed: "网络连接失败。请检查网络后重试。",
    metadata_invalid: "更新说明文件无效。请稍后重试或联系发布者。",
    download_failed: "更新下载失败。请重新下载。",
    verification_failed: "更新包校验或签名验证失败。请勿安装，并联系发布者。",
    check_failed: "更新检查失败。请稍后重试。"
  }
} : {
  title: "About & Updates",
  help: "Review version, build provenance, and database migration status. Desktop updates are enabled only in packaged Windows builds and never download or install silently.",
  version: "App version",
  schema: "Data version",
  platform: "Platform",
  build: "Build type",
  commit: "Build commit",
  migration: "Data migration",
  check: "Check for updates",
  checking: "Checking…",
  download: "Download update",
  install: "Confirm restart and install",
  defer: "Defer",
  openStore: "Open safe update source",
  copyDiagnostics: "Copy privacy-safe diagnostics",
  copied: "Diagnostics copied without API keys, chat text, personas, or character prompts.",
  recoveryNote: "After installing a new version, any database upgrade starts with an integrity check and pre-upgrade safety copy.",
  noUpdate: "This is the latest version.",
  available: (version: string) => `Version ${version} is available`,
  downloaded: "Download and verification completed. Confirm to restart and install.",
  deferred: "This update was deferred. You can return and install it later.",
  disabledDev: "Real update checks are disabled in development and unpackaged builds.",
  disabledPlatform: "In-app update installation is not supported on this platform.",
  migrationReady: "Data schema is ready",
  migrationUpgraded: "Data migration completed safely on this launch",
  migrationUnknown: "Data migration state is not confirmed; run the migration checks for this version",
  migrationFailed: "Data migration failed; the original database was retained. Keep the upgrade-recovery copy and seek support",
  migrationTooNew: "Data was created by a newer version. Update the app before allowing any writes",
  firstLaunch: (from: string | null, count: number) => `Version upgrade completed${from ? ` from ${from}` : ""}; ${count} data migration(s) applied.`,
  confirmTitle: "Install update",
  confirmMessage: "The app will close and install the downloaded update. A safety copy is created before any database upgrade. Continue now?",
  cancel: "Cancel",
  errors: {
    network_failed: "Network access failed. Check the connection and try again.",
    metadata_invalid: "The update metadata is invalid. Try later or contact the publisher.",
    download_failed: "The update download failed. Start the download again.",
    verification_failed: "Update checksum or signature verification failed. Do not install it; contact the publisher.",
    check_failed: "The update check failed. Try again later."
  }
};

const formatBytes = (value: number | null) => value === null ? "—" : value < 1024 * 1024
  ? `${Math.round(value / 1024)} KB`
  : `${(value / (1024 * 1024)).toFixed(1)} MB`;

const writeClipboard = async (value: string) => {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
};

export function AboutUpdatesPanel({ language }: { language: AppLanguage }) {
  const copy = useMemo(() => copyFor(language), [language]);
  const [info, setInfo] = useState<AppInfoDTO | null>(null);
  const [update, setUpdate] = useState<DesktopUpdateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const bridge = window.starCompanionDesktop;

  useEffect(() => {
    void api.app.info().then(setInfo).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Unable to read application information"));
    if (!bridge) return;
    void bridge.getUpdateState().then(setUpdate).catch(() => setError(copy.errors.check_failed));
    return bridge.onUpdateState(setUpdate);
  }, [bridge, copy.errors.check_failed]);

  const invoke = async (action: "check" | "download" | "defer" | "install") => {
    if (!bridge) return;
    setError(null);
    try {
      const next = action === "check" ? await bridge.checkForUpdates()
        : action === "download" ? await bridge.downloadUpdate()
        : action === "defer" ? await bridge.deferUpdate()
        : await bridge.installUpdate();
      setUpdate(next);
    } catch {
      setError(copy.errors.check_failed);
    }
  };

  const copyDiagnostics = async () => {
    if (!info) return;
    const diagnostic = JSON.stringify({
      product: "Star Companion",
      webVersion: __STAR_COMPANION_APP_VERSION__,
      webSchemaVersion: __STAR_COMPANION_SCHEMA_VERSION__,
      webSchemaChecksum: __STAR_COMPANION_SCHEMA_CHECKSUM__,
      webBuildCommit: __STAR_COMPANION_BUILD_COMMIT__,
      appVersion: info.appVersion,
      schemaVersion: info.schemaVersion,
      schemaChecksum: info.schemaChecksum,
      platform: info.platform,
      buildType: info.buildType,
      buildCommit: info.buildCommit,
      migration: info.migration,
      update: update ? {
        status: update.status,
        availableVersion: update.availableVersion,
        lastCheckedAt: update.lastCheckedAt,
        errorCode: update.errorCode,
        disabledReason: update.disabledReason
      } : { capability: info.update.capability }
    }, null, 2);
    await writeClipboard(diagnostic);
    setSuccess(copy.copied);
  };

  const updateMessage = update?.status === "not_available" ? copy.noUpdate
    : update?.status === "available" && update.availableVersion ? copy.available(update.availableVersion)
    : update?.status === "downloaded" ? copy.downloaded
    : update?.status === "deferred" ? copy.deferred
    : update?.status === "disabled" ? update.disabledReason === "development_build" ? copy.disabledDev : copy.disabledPlatform
    : null;
  const updateError = update?.errorCode ? copy.errors[update.errorCode] : null;

  return (
    <>
      <Panel className={panelClassName} title={copy.title}>
        <div className="space-y-5" data-testid="about-updates-panel">
          <p className="text-sm leading-6 text-slate-400">{copy.help}</p>
          {error ? <ErrorNotice message={error} /> : null}
          {updateError ? <ErrorNotice message={`${updateError} ${copy.check}`} /> : null}
          {success ? <SuccessNotice message={success} /> : null}
          {info ? (
            <div className={`grid gap-3 rounded-lg p-4 text-sm sm:grid-cols-2 ${surfaceClassName}`}>
              {[
                [copy.version, info.appVersion],
                [copy.schema, info.schemaVersion],
                [copy.platform, info.platform],
                [copy.build, info.buildType],
                [copy.commit, info.buildCommit || "—"],
                [copy.migration, info.migration.status === "upgraded" ? copy.migrationUpgraded : info.migration.status === "ready" ? copy.migrationReady : info.migration.status === "failed" ? copy.migrationFailed : info.migration.status === "too_new" ? copy.migrationTooNew : copy.migrationUnknown]
              ].map(([label, value]) => <div key={label}><div className="text-xs uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 break-all text-slate-100">{value}</div></div>)}
            </div>
          ) : null}
          {info?.migration.status === "upgraded" ? (
            <div className="flex gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3 text-sm text-emerald-200" data-testid="upgrade-first-launch-summary">
              <CheckCircle2 className="mt-0.5 shrink-0" size={16} />
              {copy.firstLaunch(info.migration.previousAppVersion, info.migration.appliedCount)}
            </div>
          ) : null}
          <div className={`space-y-3 rounded-lg p-4 ${surfaceClassName}`}>
            <div className="flex gap-2 text-sm text-slate-300"><ShieldCheck className="mt-0.5 shrink-0 text-emerald-300" size={17} /><span>{copy.recoveryNote}</span></div>
            {updateMessage ? <p className="text-sm text-slate-200" data-testid="update-status-message">{updateMessage}</p> : null}
            {update?.status === "downloading" ? (
              <div data-testid="update-download-progress">
                <div className="mb-1 flex justify-between text-xs text-slate-400"><span>{Math.round(update.progressPercent || 0)}%</span><span>{formatBytes(update.transferredBytes)} / {formatBytes(update.totalBytes)}</span></div>
                <div className="h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-ember-400 transition-all" style={{ width: `${update.progressPercent || 0}%` }} /></div>
              </div>
            ) : null}
            {update?.releaseNotes ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-black/20 p-3 text-xs leading-5 text-slate-300" data-testid="update-release-notes">{update.releaseNotes}</pre> : null}
            {update?.lastCheckedAt ? <p className="text-xs text-slate-500">{new Date(update.lastCheckedAt).toLocaleString(language === "zh-CN" ? "zh-CN" : "en-US")}</p> : null}
            <div className="flex flex-wrap gap-2">
              {info?.update.capability === "desktop" ? <Button disabled={!bridge || update?.status === "disabled" || update?.status === "checking" || update?.status === "downloading" || update?.status === "installing"} variant="secondary" onClick={() => void invoke("check")}><RefreshCw size={16} />{update?.status === "checking" ? copy.checking : copy.check}</Button> : null}
              {update?.status === "available" ? <Button onClick={() => void invoke("download")}><Download size={16} />{copy.download}</Button> : null}
              {update?.status === "downloaded" || update?.status === "deferred" ? <Button onClick={() => setConfirmInstall(true)}><CheckCircle2 size={16} />{copy.install}</Button> : null}
              {update?.status === "available" || update?.status === "downloaded" ? <Button variant="secondary" onClick={() => void invoke("defer")}>{copy.defer}</Button> : null}
              {info?.update.capability === "external_store" && info.update.externalUrl ? <Button variant="secondary" onClick={() => window.open(info.update.externalUrl || "", "_blank", "noopener,noreferrer")}><ExternalLink size={16} />{copy.openStore}</Button> : null}
              <Button disabled={!info} variant="secondary" onClick={() => void copyDiagnostics()}><Clipboard size={16} />{copy.copyDiagnostics}</Button>
            </div>
          </div>
        </div>
      </Panel>
      {confirmInstall ? <ConfirmDialog title={copy.confirmTitle} message={copy.confirmMessage} confirmLabel={copy.install} cancelLabel={copy.cancel} variant="primary" onCancel={() => setConfirmInstall(false)} onConfirm={() => { setConfirmInstall(false); void invoke("install"); }} /> : null}
    </>
  );
}
