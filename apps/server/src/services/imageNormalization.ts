import jpeg from "jpeg-js";
import { PNG } from "pngjs";
export class ImageValidationError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_ASPECT_RATIO = 100;
export type SupportedImageMime = "image/png" | "image/jpeg";

const readPngSize = (bytes: Buffer) => {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mimeType: "image/png" as const };
};

const readJpegSize = (bytes: Buffer) => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null;
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3), mimeType: "image/jpeg" as const };
    }
    offset += length;
  }
  return null;
};

const assertDimensions = (width: number, height: number) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new ImageValidationError(400, "The image dimensions are invalid.");
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) throw new ImageValidationError(413, "The decoded image is too large. Use an image no larger than 25 megapixels.");
  if (Math.max(width / height, height / width) > MAX_ASPECT_RATIO) throw new ImageValidationError(400, "The image aspect ratio is too extreme to process safely.");
};

export const validateStoredImage = (input: { data: Buffer; mimeType: SupportedImageMime; width: number; height: number }) => {
  if (!input.data.length || input.data.length > MAX_MESSAGE_IMAGE_BYTES) throw new ImageValidationError(413, "The stored image size is invalid.");
  const header = readPngSize(input.data) ?? readJpegSize(input.data);
  if (!header || header.mimeType !== input.mimeType) throw new ImageValidationError(400, "The stored image signature does not match its declared type.");
  assertDimensions(header.width, header.height);
  try {
    const decoded = header.mimeType === "image/png"
      ? PNG.sync.read(input.data, { checkCRC: true, skipRescale: false })
      : jpeg.decode(input.data, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 160 });
    assertDimensions(decoded.width, decoded.height);
    if (decoded.width !== input.width || decoded.height !== input.height) throw new ImageValidationError(400, "The stored image dimensions do not match its manifest.");
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError(400, "The stored image is damaged or cannot be decoded safely.");
  }
};

export const normalizeUploadedImage = (input: { dataBase64: string; mimeType: SupportedImageMime }) => {
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== input.dataBase64.replace(/\s+/g, "").replace(/=+$/, "")) throw new ImageValidationError(400, "The image data is not valid base64.");
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageValidationError(413, "Each image must be 10 MB or smaller.");
  const header = readPngSize(bytes) ?? readJpegSize(bytes);
  if (!header) throw new ImageValidationError(400, "Only valid PNG or JPEG image data is accepted.");
  if (header.mimeType !== input.mimeType) throw new ImageValidationError(400, "The declared image type does not match the file signature.");
  assertDimensions(header.width, header.height);
  try {
    if (header.mimeType === "image/png") {
      const decoded = PNG.sync.read(bytes, { checkCRC: true, skipRescale: false });
      assertDimensions(decoded.width, decoded.height);
      const data = PNG.sync.write(decoded, { colorType: 6, inputColorType: 6 });
      if (data.length > MAX_MESSAGE_IMAGE_BYTES) throw new ImageValidationError(413, "The normalized image is too large.");
      return { data, mimeType: "image/png" as const, width: decoded.width, height: decoded.height };
    }
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 160 });
    assertDimensions(decoded.width, decoded.height);
    const encoded = jpeg.encode({ data: decoded.data, width: decoded.width, height: decoded.height }, 90).data;
    if (encoded.length > MAX_MESSAGE_IMAGE_BYTES) throw new ImageValidationError(413, "The normalized image is too large.");
    return { data: Buffer.from(encoded), mimeType: "image/jpeg" as const, width: decoded.width, height: decoded.height };
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    throw new ImageValidationError(400, "The image is damaged or cannot be decoded safely.");
  }
};
