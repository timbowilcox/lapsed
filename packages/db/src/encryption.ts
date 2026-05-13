import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM-recommended
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256

/**
 * Decode a base64-encoded key into a 32-byte buffer.
 * The TOKEN_ENCRYPTION_KEY env var stores 32 random bytes as base64.
 */
export function decodeEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `encryption key must decode to ${KEY_LENGTH} bytes, got ${key.length}`,
    );
  }
  return key;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a buffer encoded as: iv(12) || authTag(16) || ciphertext(variable).
 * Pure function — caller is responsible for passing a 32-byte key.
 */
export function encryptToken(plaintext: string, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * Decrypt a ciphertext buffer produced by encryptToken.
 * Throws if the buffer is malformed or the auth tag fails verification.
 */
export function decryptToken(ciphertext: Buffer, key: Buffer): string {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }
  if (ciphertext.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("ciphertext too short");
  }
  const iv = ciphertext.subarray(0, IV_LENGTH);
  const authTag = ciphertext.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const payload = ciphertext.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
  return plaintext.toString("utf8");
}
