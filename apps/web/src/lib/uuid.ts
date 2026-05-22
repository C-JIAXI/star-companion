export const generateId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const hex = "0123456789abcdef";
  const chars = new Uint8Array(36);
  crypto.getRandomValues(chars);
  let id = "";
  for (let i = 0; i < 36; i++) {
    const c = chars[i]!;
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      id += "-";
    } else if (i === 14) {
      id += "4";
    } else if (i === 19) {
      id += hex[(c & 0x03) | 0x08];
    } else {
      id += hex[c & 0x0f];
    }
  }
  return id;
};
