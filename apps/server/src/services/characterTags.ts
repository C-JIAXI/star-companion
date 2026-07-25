export type CharacterTagOperation = "add" | "remove";

const toCharacterTags = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags = value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.filter(
    (tag, index) =>
      tags.findIndex((candidate) => candidate.toLowerCase() === tag.toLowerCase()) === index
  );
};

export const applyCharacterTagOperation = (
  currentValue: unknown,
  operation: CharacterTagOperation,
  requestedTags: string[]
) => {
  const currentTags = toCharacterTags(currentValue);
  const requestedKeys = new Set(requestedTags.map((tag) => tag.toLowerCase()));

  if (operation === "remove") {
    return currentTags.filter((tag) => !requestedKeys.has(tag.toLowerCase()));
  }

  const result = [...currentTags];
  const resultKeys = new Set(currentTags.map((tag) => tag.toLowerCase()));
  for (const tag of requestedTags) {
    const key = tag.toLowerCase();
    if (!resultKeys.has(key)) {
      result.push(tag);
      resultKeys.add(key);
    }
  }

  if (result.length > 24) {
    throw new RangeError("A character cannot have more than 24 tags");
  }

  return result;
};
