const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const MAX_DIMENSION = 16_384;

export const acceptedChatImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

const readFileDataUrl = (file: File, signal?: AbortSignal) => new Promise<string>((resolve, reject) => {
  signal?.throwIfAborted();
  const reader = new FileReader();
  const cleanup = () => { signal?.removeEventListener("abort", cancel); reader.onerror = null; reader.onload = null; };
  const cancel = () => { cleanup(); reader.abort(); reject(new DOMException("Image preparation cancelled.", "AbortError")); };
  reader.onerror = () => { cleanup(); reject(new Error("The image could not be read.")); };
  reader.onload = () => { const result = String(reader.result ?? ""); cleanup(); resolve(result); };
  signal?.addEventListener("abort", cancel, { once: true });
  reader.readAsDataURL(file);
});

const loadImage = (url: string, signal?: AbortSignal) => new Promise<HTMLImageElement>((resolve, reject) => {
  signal?.throwIfAborted();
  const image = new window.Image();
  const cleanup = () => { signal?.removeEventListener("abort", cancel); image.onload = null; image.onerror = null; };
  const cancel = () => { cleanup(); image.removeAttribute("src"); reject(new DOMException("Image preparation cancelled.", "AbortError")); };
  image.onload = () => { cleanup(); resolve(image); };
  image.onerror = () => { cleanup(); reject(new Error("The image is damaged or uses an unsupported format.")); };
  signal?.addEventListener("abort", cancel, { once: true });
  image.src = url;
});

export const normalizeChatImageFile = async (file: File, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  if (!acceptedChatImageTypes.has(file.type)) throw new Error("Only JPEG, PNG, WebP, GIF, and AVIF images are supported.");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("Each image must be 10 MB or smaller.");
  const sourceUrl = await readFileDataUrl(file, signal);
  const image = await loadImage(sourceUrl, signal);
  signal?.throwIfAborted();
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error("The decoded image must not exceed 25 megapixels.");
  if (Math.max(width / height, height / width) > 100) throw new Error("The image aspect ratio is too extreme.");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("This platform cannot process the image safely.");
  context.drawImage(image, 0, 0, width, height);
  const preserveTransparency = file.type === "image/png" || file.type === "image/webp" || file.type === "image/gif" || file.type === "image/avif";
  const mimeType = preserveTransparency ? "image/png" as const : "image/jpeg" as const;
  const normalized = canvas.toDataURL(mimeType, 0.9);
  const comma = normalized.indexOf(",");
  if (comma < 0) throw new Error("The image could not be normalized.");
  return { dataBase64: normalized.slice(comma + 1), mimeType, originalFilename: file.name };
};
