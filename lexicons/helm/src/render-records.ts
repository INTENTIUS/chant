/**
 * The in-process ledger of `HelmRender` invocations — split out of
 * `./render.ts` so a post-synth check can read it without importing the
 * render machinery (#1979 follow-up, found by the hosted audit's bump).
 *
 * WHM503 (`./lint/post-synth/whm503.ts`) scans these records, and post-synth
 * barrels are edge-imported by the hosted audit service: everything they
 * reach through static imports must be safe to initialize on workerd.
 * `render.ts` is not — it imports the full `@intentius/chant` barrel, whose
 * static graph reaches the TypeScript compiler (fold-import), and
 * TypeScript's own module init touches `__filename`, which crashes the
 * worker at startup. This module carries only the record shape and the
 * ledger, imports nothing but a type, and keeps the barrel edge-clean;
 * `render.ts` re-exports it all, so the lexicon's public surface is
 * unchanged.
 */

import type { HelmCapabilityProfile } from "./config";

/**
 * What one `HelmRender` invocation recorded about itself. `capabilityProfile`
 * is the profile identity the render was pinned against; `undefined` means
 * the render was unpinned and its bytes depend on the local helm binary's
 * defaults.
 *
 * Pinned renders (profile present — the v1 gate, see #1237) also carry the
 * digest pair:
 *
 * - `inputDigest` — `sha256:` over the canonical JSON of the declared inputs
 *   (chart reference, version, values, capability facts). Shared with the
 *   release-ledger digest #1243 records on deploy, via `helmInputDigest`.
 *   Answers "same inputs?" without touching any bytes.
 * - `contentDigest` — `sha256:` over the canonical rendered bytes
 *   (`canonicalizeRender`). The artifact identity: answers "same bytes on
 *   the cluster?".
 *
 * They diverge exactly when the render is not a function of its declared
 * inputs — `renderStability` in ./render-digest.ts names that.
 *
 * Unpinned renders record neither digest. Their bytes are a function of the
 * local helm binary's defaulted capabilities, so a digest over them would
 * assert an identity the render does not have — it would differ across
 * machines that did nothing differently, and equal digests would still
 * prove nothing about a cluster. No digest is the honest record.
 */
export interface HelmRenderRecord {
  /** The render's logical name (`HelmRenderProps.name`) — also the helm release name baked into the bytes. */
  name: string;
  chart: string;
  version?: string;
  capabilityProfile?: HelmCapabilityProfile;
  /** Input-side identity (#1237/#1243). Present only for pinned renders. */
  inputDigest?: string;
  /** Content-side identity over canonical rendered bytes (#1237). Present only for pinned renders. */
  contentDigest?: string;
  /**
   * The build-time coalesced-values probe's digest (#1251), present only
   * when the probe ran — a pinned render of a local chart (the probe needs
   * the chart source on disk, so a repo-fetched chart never gets one).
   */
  coalescedValuesDigest?: string;
}

const renderRecords: HelmRenderRecord[] = [];

/** Append one invocation's record (called by `HelmRender`, ./render.ts). */
export function recordHelmRender(record: HelmRenderRecord): void {
  renderRecords.push(record);
}

/** Every render recorded in this process, in invocation order. */
export function getHelmRenderRecords(): readonly HelmRenderRecord[] {
  return renderRecords;
}

/** Reset the record list (test isolation). */
export function clearHelmRenderRecords(): void {
  renderRecords.length = 0;
}
