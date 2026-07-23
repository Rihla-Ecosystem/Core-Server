/**
 * jsonParser.service.ts
 *
 * Recursively walks an arbitrary JSON value (object, array, or primitive)
 * and extracts every "meaningful" string it finds.
 *
 * A string is considered meaningful unless it is:
 *  - empty / whitespace-only
 *  - a UUID
 *  - a purely numeric string ("123", "-4.5")
 *  - the value of a key that looks like an identifier (id, _id, uuid, guid, ...)
 *
 * Numbers, booleans and null are always ignored, since they carry no
 * embeddable semantic text on their own.
 *
 * NOTE: kept as custom logic — LangChain's document loaders (e.g. JSONLoader)
 * work off fixed jq-style pointers into a known JSON shape and don't support
 * "walk anything, skip ids/uuids/numbers" extraction, which is exactly what
 * this feature needs for arbitrary uploaded JSON.
 */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NUMERIC_STRING_REGEX = /^-?\d+(\.\d+)?$/;

const ID_KEY_REGEX = /(^|_)(id|uuid|guid)$/i;

function isIdentifierKey(key?: string): boolean {
  if (!key) return false;
  return ID_KEY_REGEX.test(key.trim());
}

function isMeaningfulString(value: string, key?: string): boolean {
  const trimmed = value.trim();

  if (trimmed.length === 0) return false;
  if (UUID_REGEX.test(trimmed)) return false;
  if (NUMERIC_STRING_REGEX.test(trimmed)) return false;
  if (isIdentifierKey(key)) return false;

  return true;
}

/**
 * Recursively extracts meaningful text strings from any JSON value.
 */
export function extractMeaningfulText(value: unknown, key?: string): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    return isMeaningfulString(value, key) ? [value.trim()] : [];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractMeaningfulText(item, key));
  }

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([childKey, childValue]) => extractMeaningfulText(childValue, childKey)
    );
  }

  return [];
}

/**
 * Parses a raw JSON buffer/string and returns the merged, extracted text
 * ready for chunking.
 */
export function parseJsonToText(raw: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Invalid JSON file: could not be parsed.");
  }

  const fragments = extractMeaningfulText(parsed);
  return fragments.join("\n\n").trim();
}