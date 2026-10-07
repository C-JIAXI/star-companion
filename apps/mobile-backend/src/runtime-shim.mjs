// The Android runtime bundled by capacitor-nodejs is a Node.js 18 build with ICU disabled.
// Modern backend code assumes a full Node runtime, so the embedded backend can throw before it
// ever listens (for example `new TextDecoder("utf-8", { fatal: true })` raises ERR_NO_ICU, and
// `Intl` is undefined, breaking usage-ledger and timezone handling). This module restores the
// small subset of behaviour the backend relies on and MUST be imported before any server-dist
// module; index.mjs imports it first for that reason.

const OriginalTextDecoder = globalThis.TextDecoder;

let textDecoderFatalSupported = true;
try {
  new OriginalTextDecoder("utf-8", { fatal: true });
} catch {
  textDecoderFatalSupported = false;
}

if (!textDecoderFatalSupported) {
  globalThis.TextDecoder = class TextDecoder extends OriginalTextDecoder {
    constructor(label, options) {
      const resolved = options ? { ...options } : options;
      if (resolved) delete resolved.fatal;
      super(label, resolved);
    }
  };
}

const pad2 = (value) => String(value).padStart(2, "0");
const isUtcZone = (timeZone) => {
  if (timeZone == null) return false;
  const zone = String(timeZone).trim().toLowerCase();
  return zone === "" || zone === "utc" || zone === "gmt" || zone === "etc/utc" || zone === "etc/gmt";
};

// Without ICU there is no IANA timezone database, so arbitrary named zones cannot be resolved.
// The backend only reads year/month/day parts, so this fallback returns UTC parts for UTC and the
// device's own zone (the OS local time = the user's timezone) for anything else.
class FallbackDateTimeFormat {
  constructor(_locales, options = {}) {
    this.year = options && options.year;
    this.month = options && options.month;
    this.day = options && options.day;
    this.timeZone = (options && options.timeZone) || "UTC";
  }

  resolvedOptions() {
    return { locale: "en-CA", timeZone: this.timeZone, year: "numeric", month: "2-digit", day: "2-digit" };
  }

  formatToParts(date = new Date()) {
    const utc = isUtcZone(this.timeZone);
    const year = utc ? date.getUTCFullYear() : date.getFullYear();
    const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
    const day = utc ? date.getUTCDate() : date.getDate();
    return [
      { type: "year", value: String(year) },
      { type: "literal", value: "-" },
      { type: "month", value: pad2(month) },
      { type: "literal", value: "-" },
      { type: "day", value: pad2(day) }
    ];
  }

  format(date = new Date()) {
    return this.formatToParts(date).map((part) => part.value).join("");
  }
}

const intlAvailable = typeof globalThis.Intl !== "undefined" && typeof globalThis.Intl.DateTimeFormat === "function";
if (!intlAvailable) {
  globalThis.Intl = { ...(globalThis.Intl ?? {}), DateTimeFormat: FallbackDateTimeFormat };
}

console.log(
  `[runtime-shim] TextDecoderFatal=${textDecoderFatalSupported} Intl=${intlAvailable ? "native" : "fallback"} ` +
    `localOffsetMinutes=${new Date().getTimezoneOffset()}`
);
