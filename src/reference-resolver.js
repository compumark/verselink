const SLOT_ALIASES = new Map([
  ["helmet", "HELMET"], ["helmets", "HELMET"],
  ["core", "CORE"], ["torso", "CORE"],
  ["arms", "ARMS"], ["arm", "ARMS"],
  ["legs", "LEGS"], ["leg", "LEGS"]
]);
const COLOR_WORDS = new Set(["aqua", "black", "blue", "green", "grey", "gray", "orange", "olive", "purple", "red", "sienna", "tan", "violet", "white", "yellow"]);

const words = (value) => String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const normalizedWords = value => new Set(words(value));
const hasCompleteNameMatch = (title, productName) => {
  const expected = normalizedWords(productName);
  const actual = normalizedWords(title);
  return !expected.size || [...expected].every(word => actual.has(word));
};

export const equipmentSlotFromText = (value) => {
  for (const word of words(value)) {
    const slot = SLOT_ALIASES.get(word);
    if (slot) return slot;
  }
  return null;
};

export const selectWikiCandidate = (candidates, { productName, blueprintTag } = {}) => {
  const expectedSlot = equipmentSlotFromText(blueprintTag);
  const nameWords = normalizedWords(productName);
  const compatible = candidates.filter((candidate) => {
    if (!hasCompleteNameMatch(candidate?.title, productName)) return false;
    if (!expectedSlot) return true;
    return equipmentSlotFromText(candidate.title) === expectedSlot;
  });
  if (!compatible.length) return null;
  return [...compatible].sort((a, b) => {
    const score = (candidate) => words(candidate.title).reduce((total, word) => total + (nameWords.has(word) ? 1 : 0), 0);
    return score(b) - score(a);
  })[0];
};

export const selectWikiImageFile = (images, { productName, blueprintTag } = {}) => {
  const expected = normalizedWords(productName);
  const expectedSlot = equipmentSlotFromText(blueprintTag);
  const expectedColors = [...expected].filter(word => COLOR_WORDS.has(word));
  const minimumScore = Math.min(3, Math.max(1, expected.size - expectedColors.length));
  const compatible = (Array.isArray(images) ? images : []).filter((image) => {
    const title = String(image?.title || "").replace(/^File:/i, "");
    const actual = normalizedWords(title);
    if (!title || actual.has("placeholder") || actual.has("uex")) return false;
    if (expectedSlot && equipmentSlotFromText(title) !== expectedSlot) return false;
    if (expectedColors.length && !expectedColors.every(color => actual.has(color))) return false;
    const score = [...actual].reduce((total, word) => total + (expected.has(word) ? 1 : 0), 0);
    return score >= minimumScore;
  });
  if (!compatible.length) return null;
  return [...compatible].sort((a, b) => {
    const score = (image) => words(image.title).reduce((total, word) => total + (expected.has(word) ? 1 : 0), 0);
    return score(b) - score(a);
  })[0];
};

export const wikiSourceMatchesProduct = (sourceUrl, productName) => {
  if (!sourceUrl || !productName) return false;
  try {
    const sourceTitle = decodeURIComponent(new URL(sourceUrl).pathname.split("/").pop() || "").replace(/_/g, " ");
    return hasCompleteNameMatch(sourceTitle, productName);
  } catch { return false; }
};

export const shouldRefreshReference = ({ checkedAt, force = false, now = Date.now(), maxAgeMs = 30 * 24 * 60 * 60 * 1000 } = {}) => {
  if (force || !checkedAt) return true;
  const timestamp = new Date(checkedAt).getTime();
  return !Number.isFinite(timestamp) || now - timestamp >= maxAgeMs;
};
