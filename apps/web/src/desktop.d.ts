interface DesktopUpdateState {
  status: "disabled" | "idle" | "checking" | "available" | "not_available" | "downloading" | "downloaded" | "deferred" | "installing" | "error";
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  progressPercent: number | null;
  transferredBytes: number | null;
  totalBytes: number | null;
  lastCheckedAt: string | null;
  errorCode: "network_failed" | "metadata_invalid" | "download_failed" | "verification_failed" | "check_failed" | null;
  disabledReason: "development_build" | "unsupported_platform" | string | null;
}

declare const __STAR_COMPANION_APP_VERSION__: string;
declare const __STAR_COMPANION_SCHEMA_VERSION__: string;
declare const __STAR_COMPANION_SCHEMA_CHECKSUM__: string;
declare const __STAR_COMPANION_BUILD_COMMIT__: string | null;

interface Window {
  starCompanionDesktop?: {
    getUpdateState: () => Promise<DesktopUpdateState>;
    checkForUpdates: () => Promise<DesktopUpdateState>;
    downloadUpdate: () => Promise<DesktopUpdateState>;
    deferUpdate: () => Promise<DesktopUpdateState>;
    installUpdate: () => Promise<DesktopUpdateState>;
    onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  };
}
