// Inbound authentication for the harness control surface.
//
// On the host, the harness listens on loopback — reachable by the containerized
// services through the bridge, and by EVERY other process running as the developer.
// So placement cannot be the access control: a bearer token is.

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time bearer comparison.
 *
 * Compares SHA-256 digests rather than the raw strings for two reasons:
 * `timingSafeEqual` THROWS on a length mismatch (so raw values would need a length
 * check that itself leaks length), and digests are always 32 bytes.
 *
 * An empty expected secret NEVER authenticates. This is the same trap as an empty
 * `ANTHROPIC_API_KEY` winning its precedence slot: without the guard, an unset
 * `HARNESS_SHARED_SECRET` would make an empty bearer valid and the whole surface
 * open. The boot check in `index.ts` is what turns that into a loud failure; this
 * is the one that makes it a closed one.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  if (expected.length === 0) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}
