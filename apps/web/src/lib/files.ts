import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { resolveApiUrl } from "./appBackend";

type MobileTextExportResult = {
  filename: string;
  path: string;
  url: string;
};

type ApiEnvelope<T> = {
  ok: true;
  data: T;
} | {
  ok: false;
  error: string;
};

const isNativeAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

const saveBlob = (filename: string, blob: Blob) => {
  const file = new File([blob], filename, { type: blob.type });
  const canShareFile =
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });

  if (canShareFile && typeof navigator.share === "function") {
    void navigator.share({ files: [file], title: filename }).catch(() => {
      saveBlobWithAnchor(filename, blob);
    });
    return;
  }

  saveBlobWithAnchor(filename, blob);
};

const saveBlobWithAnchor = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

export const downloadJson = (filename: string, data: unknown) => {
  saveBlob(
    filename,
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  );
};

export const downloadText = (
  filename: string,
  text: string,
  mimeType = "text/plain;charset=utf-8"
) => {
  saveBlob(filename, new Blob([text], { type: mimeType }));
};

export const saveJsonFile = async (filename: string, data: unknown) => {
  if (isNativeAndroid()) {
    await saveTextFile(filename, JSON.stringify(data, null, 2));
    return;
  }

  downloadJson(filename, data);
};

export const saveTextFile = async (
  filename: string,
  text: string,
  mimeType = "text/plain;charset=utf-8"
) => {
  if (isNativeAndroid()) {
    const response = await fetch(resolveApiUrl("/api/exports/text"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, content: text })
    });
    const payload = (await response.json()) as ApiEnvelope<MobileTextExportResult>;
    if (!response.ok || !payload.ok) {
      throw new Error("error" in payload ? payload.error : "Failed to export text file");
    }

    await Share.share({
      title: payload.data.filename,
      text: payload.data.filename,
      url: payload.data.url,
      dialogTitle: payload.data.filename
    });
    return;
  }

  downloadText(filename, text, mimeType);
};

export const readFileText = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Failed to read file"))
    );
    reader.readAsText(file);
  });

export const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Failed to read file"))
    );
    reader.readAsDataURL(file);
  });
