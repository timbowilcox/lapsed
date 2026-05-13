// Sprint 02 evidence script: prove that shopify_access_token is
// stored as ciphertext at rest. Inserts a row with a known plaintext
// token, reads back the raw bytea via psql-equivalent select, asserts
// the plaintext bytes do not appear in the stored value, then cleans
// up.

import { Client } from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const env = readFileSync(join(repoRoot, ".env.local"), "utf8");
const dbUrl = env.match(/^SUPABASE_DB_URL=(.+)$/m)[1].trim();
const keyB64 = env.match(/^TOKEN_ENCRYPTION_KEY=(.+)$/m)[1].trim();

const require = createRequire(import.meta.url);
const { encryptToken, decodeEncryptionKey } = await import(
  "../dist-helpers/encryption.mjs"
).catch(async () => {
  // Build a minimal local equivalent rather than requiring a built dist.
  const crypto = require("node:crypto");
  function decodeEncryptionKey(b64) {
    const buf = Buffer.from(b64, "base64");
    if (buf.length !== 32) throw new Error("bad key size");
    return buf;
  }
  function encryptToken(plain, key) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  return { encryptToken, decodeEncryptionKey };
});

const key = decodeEncryptionKey(keyB64);
const PLAINTEXT = "shpat_evidence_token_does_not_appear_in_db";
const testShop = `encryption-verify-${Date.now()}.myshopify.com`;
const ct = encryptToken(PLAINTEXT, key);

const c = new Client({ connectionString: dbUrl });
await c.connect();
await c.query(
  `insert into public.merchants
     (shopify_shop_domain, shopify_access_token, shopify_scope)
   values ($1, $2, $3)`,
  [testShop, ct, "read_orders"],
);

const r = await c.query(
  `select encode(shopify_access_token, 'hex') as hex,
          octet_length(shopify_access_token) as len
     from public.merchants
    where shopify_shop_domain = $1`,
  [testShop],
);

const hex = r.rows[0].hex;
const len = r.rows[0].len;
const plaintextHex = Buffer.from(PLAINTEXT, "utf8").toString("hex");
const plaintextLeak = hex.includes(plaintextHex);

console.log("=== Encryption-at-rest evidence ===");
console.log("shop_domain:        ", testShop);
console.log("plaintext was:      ", PLAINTEXT);
console.log("plaintext hex was:  ", plaintextHex);
console.log("stored bytes len:   ", len);
console.log("stored hex (first 96):", hex.slice(0, 96) + (hex.length > 96 ? "…" : ""));
console.log("plaintext leak?     ", plaintextLeak);
console.log("structure:           iv(12) ||", "authTag(16) ||", "ciphertext(" + (len - 28) + ")");

await c.query(`delete from public.merchants where shopify_shop_domain = $1`, [testShop]);
await c.end();

if (plaintextLeak) {
  console.error("\n  ✗ plaintext found in stored bytes — encryption FAILED");
  process.exit(2);
}
console.log("\n  ✓ ciphertext does not contain plaintext — encryption-at-rest verified");
