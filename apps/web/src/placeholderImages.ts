import { useMemo } from "react";

const PLACEHOLDER_IMAGES = [
  "/placeholder-cover.png",
  "/placeholder-cover-2.png",
  "/placeholder-cover-3.png"
];

const getStableRandomIndex = (): number => {
  return Math.floor(Math.random() * PLACEHOLDER_IMAGES.length);
};

export const usePlaceholderSrc = (avatar: string | null | undefined, stableKey?: string): string => {
  const randomIndex = useMemo(() => getStableRandomIndex(), [stableKey]);
  return avatar || PLACEHOLDER_IMAGES[randomIndex];
};

export const getPlaceholderSrc = (avatar: string | null | undefined): string => {
  return avatar || PLACEHOLDER_IMAGES[Math.floor(Math.random() * PLACEHOLDER_IMAGES.length)];
};
