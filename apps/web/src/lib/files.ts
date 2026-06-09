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

export const downloadText = (filename: string, text: string) => {
  saveBlob(filename, new Blob([text], { type: "text/plain;charset=utf-8" }));
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
