// Pure ESM mirror of src/encryption.ts for runtime scripts that can't
// import .ts directly. Kept in sync manually — verify-encryption.mjs
// is the only consumer and is run from CI evidence reports.

import { createCipheriv, randomBytes } from "node:crypto";

export function decodeEncryptionKey(b64) {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) throw new Error("encryption key must decode to 32 bytes");
  return buf;
}

export function encryptToken(plaintext, key) {
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
