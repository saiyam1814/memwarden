//
// Constant-time bearer-token comparison. Ported from the original
// src/auth.ts (only timingSafeCompare is needed for the Phase-0 auth
// middleware; the viewer-CSP helpers are out of scope). Both operands are
// HMAC'd under a process-ephemeral key before timingSafeEqual so the
// comparison is length-independent and constant-time.

import { timingSafeEqual, createHmac, randomBytes } from "node:crypto";

const hmacKey = randomBytes(32);

export function timingSafeCompare(a: string, b: string): boolean {
  const hmacA = createHmac("sha256", hmacKey).update(a).digest();
  const hmacB = createHmac("sha256", hmacKey).update(b).digest();
  return timingSafeEqual(hmacA, hmacB);
}
