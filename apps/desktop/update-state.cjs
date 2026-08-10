const UPDATE_STATUS = Object.freeze({
  DISABLED: "disabled",
  IDLE: "idle",
  CHECKING: "checking",
  AVAILABLE: "available",
  NOT_AVAILABLE: "not_available",
  DOWNLOADING: "downloading",
  DOWNLOADED: "downloaded",
  DEFERRED: "deferred",
  INSTALLING: "installing",
  ERROR: "error"
});

const createInitialUpdateState = ({ enabled, disabledReason = null, currentVersion }) => ({
  status: enabled ? UPDATE_STATUS.IDLE : UPDATE_STATUS.DISABLED,
  currentVersion,
  availableVersion: null,
  releaseNotes: null,
  progressPercent: null,
  transferredBytes: null,
  totalBytes: null,
  lastCheckedAt: null,
  errorCode: null,
  disabledReason: enabled ? null : disabledReason || "unsupported"
});

const classifyUpdateError = (error, phase = "checking") => {
  const text = `${error?.code || ""} ${error?.message || String(error || "")}`.toLowerCase();
  if (/checksum|sha512|signature|publisher|certificate|code sign|not signed/.test(text)) return "verification_failed";
  if (/yaml|metadata|latest\.yml|channel file|parse|unexpected token|invalid update info/.test(text)) return "metadata_invalid";
  if (/enet|econn|enotfound|etimedout|network|socket|dns|http 5\d\d|http 4\d\d/.test(text)) return "network_failed";
  if (phase === "downloading") return "download_failed";
  return "check_failed";
};

const normalizeReleaseNotes = (value) => {
  if (typeof value === "string") return value.slice(0, 8_000);
  if (Array.isArray(value)) {
    return value.map((entry) => typeof entry === "string" ? entry : entry?.note).filter(Boolean).join("\n\n").slice(0, 8_000) || null;
  }
  return null;
};

const reduceUpdateState = (state, event) => {
  const now = event.at || new Date().toISOString();
  switch (event.type) {
    case "check_started":
      if (state.status === UPDATE_STATUS.DISABLED) return state;
      return { ...state, status: UPDATE_STATUS.CHECKING, errorCode: null, progressPercent: null };
    case "update_available":
      return { ...state, status: UPDATE_STATUS.AVAILABLE, availableVersion: event.version, releaseNotes: normalizeReleaseNotes(event.releaseNotes), lastCheckedAt: now, errorCode: null };
    case "update_not_available":
      return { ...state, status: UPDATE_STATUS.NOT_AVAILABLE, availableVersion: null, releaseNotes: null, lastCheckedAt: now, errorCode: null };
    case "download_started":
      return { ...state, status: UPDATE_STATUS.DOWNLOADING, progressPercent: 0, transferredBytes: 0, totalBytes: null, errorCode: null };
    case "download_progress":
      return {
        ...state,
        status: UPDATE_STATUS.DOWNLOADING,
        progressPercent: Math.max(0, Math.min(100, Number(event.percent) || 0)),
        transferredBytes: Number(event.transferred) || 0,
        totalBytes: Number(event.total) || null
      };
    case "downloaded":
      return { ...state, status: UPDATE_STATUS.DOWNLOADED, progressPercent: 100, availableVersion: event.version || state.availableVersion, errorCode: null };
    case "deferred":
      return { ...state, status: UPDATE_STATUS.DEFERRED };
    case "install_confirmed":
      return { ...state, status: UPDATE_STATUS.INSTALLING, errorCode: null };
    case "error":
      return { ...state, status: UPDATE_STATUS.ERROR, errorCode: event.code, lastCheckedAt: phaseWasCheck(state.status) ? now : state.lastCheckedAt };
    default:
      return state;
  }
};

const phaseWasCheck = (status) => status === UPDATE_STATUS.CHECKING;

module.exports = { UPDATE_STATUS, classifyUpdateError, createInitialUpdateState, normalizeReleaseNotes, reduceUpdateState };
