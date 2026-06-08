//
// Constant-time bearer-token comparison. Both inputs are HMAC'd under a
// random per-process key and then compared with timingSafeEqual, so the
// result is independent of input length and leaks no timing about how many
// leading characters happened to match.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COMPARE_KEY = randomBytes(32);

function fingerprint(value: string): Buffer {
  return createHmac("sha256", COMPARE_KEY).update(value).digest();
}

export function timingSafeCompare(a: string, b: string): boolean {
  return timingSafeEqual(fingerprint(a), fingerprint(b));
}
