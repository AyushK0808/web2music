/**
 * Telemetry URL hashing — Unit Tests (C-3)
 * Run with: node ui/telemetry_test.js
 *
 * urlHash must be an HMAC keyed by a per-install secret, not a bare SHA-256:
 * a bare hash of a URL is recoverable by hashing a list of likely URLs.
 */

import { strict as assert } from "assert";
import { createHash, createHmac } from "crypto";
import { hmacHex } from "./src/telemetry.js";

const SECRET_A = "00".repeat(32);
const SECRET_B = "ff".repeat(32);
const URL = "https://example.com/some/page?q=1";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

await test("matches Node's reference HMAC-SHA-256", async () => {
  const expected = createHmac("sha256", Buffer.from(SECRET_A, "hex")).update(URL).digest("hex");
  assert.equal(await hmacHex(SECRET_A, URL), expected);
});

await test("is not the plain SHA-256 of the URL (dictionary attack no longer works)", async () => {
  const plain = createHash("sha256").update(URL).digest("hex");
  assert.notEqual(await hmacHex(SECRET_A, URL), plain);
});

await test("same secret + same URL is stable; different secret gives an unlinkable value", async () => {
  assert.equal(await hmacHex(SECRET_A, URL), await hmacHex(SECRET_A, URL));
  assert.notEqual(await hmacHex(SECRET_A, URL), await hmacHex(SECRET_B, URL));
});

await test("different URLs give different digests", async () => {
  assert.notEqual(await hmacHex(SECRET_A, URL), await hmacHex(SECRET_A, URL + "#x"));
});

console.log(`\n${passed} passed`);
