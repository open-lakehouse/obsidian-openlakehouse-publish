const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Dependency free base64 encoding, so it runs the same in Obsidian (desktop
 * and mobile) and in node-based tests.
 */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let result = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63] +
      ALPHABET[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    result += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + "==";
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63] +
      "=";
  }
  return result;
};

export const toBase64 = (content: string | ArrayBuffer): string =>
  bytesToBase64(
    typeof content === "string"
      ? new TextEncoder().encode(content)
      : new Uint8Array(content),
  );
