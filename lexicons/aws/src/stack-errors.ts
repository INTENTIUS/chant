/**
 * CloudFormation CLI error classification, shared by every live read path.
 *
 * Lives in its own module (rather than in ./plugin.ts, where it started) so the
 * deep reader (#1015) can classify the same failure the same way without
 * importing the plugin that imports it. ./plugin.ts re-exports it, so the
 * original import path is unchanged.
 */

/** True when a CloudFormation CLI error means the stack simply isn't there yet
 * (`ValidationError … does not exist`) — the pre-first-apply state, which live
 * queries should treat as "nothing deployed", not a failure. */
export function stackDoesNotExist(stderr: string): boolean {
  return /does not exist/i.test(stderr);
}
