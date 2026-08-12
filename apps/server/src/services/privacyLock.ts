import { createHash, timingSafeEqual } from "node:crypto";

let passcodeDigest: Buffer | null = null;

const digest = (passcode: string) => createHash("sha256").update(passcode, "utf8").digest();

export const isPrivacyLocked = () => passcodeDigest !== null;

export const lockPrivacy = (passcode: string) => {
  if (passcode.length < 4 || passcode.length > 128) return false;
  passcodeDigest = digest(passcode);
  return true;
};

export const unlockPrivacy = (passcode: string) => {
  if (!passcodeDigest) return true;
  const candidate = digest(passcode);
  if (!timingSafeEqual(passcodeDigest, candidate)) return false;
  passcodeDigest = null;
  return true;
};
