import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptToken, decryptToken, decodeEncryptionKey } from "../src/encryption";

const KEY = randomBytes(32);

describe("encryptToken / decryptToken", () => {
  it("round-trips a typical Shopify access token", () => {
    const plaintext = "shpat_abcdef1234567890";
    const ciphertext = encryptToken(plaintext, KEY);
    expect(decryptToken(ciphertext, KEY)).toBe(plaintext);
  });

  it("produces distinct ciphertexts for the same plaintext (random IV)", () => {
    const plaintext = "shpat_abcdef1234567890";
    const a = encryptToken(plaintext, KEY);
    const b = encryptToken(plaintext, KEY);
    expect(a.equals(b)).toBe(false);
  });

  it("fails when the auth tag is tampered", () => {
    const ciphertext = encryptToken("shpat_test", KEY);
    ciphertext[15] ^= 0xff;
    expect(() => decryptToken(ciphertext, KEY)).toThrow();
  });

  it("fails when the wrong key is used", () => {
    const ciphertext = encryptToken("shpat_test", KEY);
    const wrongKey = randomBytes(32);
    expect(() => decryptToken(ciphertext, wrongKey)).toThrow();
  });

  it("rejects keys of the wrong size", () => {
    expect(() => encryptToken("x", Buffer.alloc(16))).toThrow(/must be 32 bytes/);
    expect(() => decryptToken(Buffer.alloc(40), Buffer.alloc(16))).toThrow(/must be 32 bytes/);
  });

  it("rejects ciphertexts that are too short", () => {
    expect(() => decryptToken(Buffer.alloc(20), KEY)).toThrow(/too short/);
  });
});

describe("decodeEncryptionKey", () => {
  it("decodes a 32-byte base64 key", () => {
    const buf = randomBytes(32);
    expect(decodeEncryptionKey(buf.toString("base64")).equals(buf)).toBe(true);
  });

  it("rejects a key of the wrong size", () => {
    expect(() => decodeEncryptionKey(Buffer.alloc(16).toString("base64"))).toThrow(
      /must decode to 32 bytes/,
    );
  });
});
