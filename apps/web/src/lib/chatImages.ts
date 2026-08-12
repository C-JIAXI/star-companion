const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const MAX_DIMENSION = 16_384;

export const acceptedChatImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

const readFileDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error("The image could not be read."));
  reader.onload = () => resolve(String(reader.result ?? ""));
  reader.readAsDataURL(file);
});

const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new window.Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("The image is damaged or uses an unsupported format."));
  image.src = url;
});

export const normalizeChatImageFile = async (file: File) => {
  if (!acceptedChatImageTypes.has(file.type)) throw new Error("Only JPEG, PNG, WebP, GIF, and AVIF images are supported.");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("Each image must be 10 MB or smaller.");
  const sourceUrl = await readFileDataUrl(file);
  const image = await loadImage(sourceUrl);
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
