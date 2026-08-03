/**
 * Content pin for the CloudFormation Registry schema (#1390).
 *
 * cfn-lint is pinned to a git tag (`PINNED_VERSIONS.cfnLint`). The registry
 * schema could not be: it is a single "latest" artifact with no version in the
 * path, republished constantly —
 *
 *     $ curl -sI .../CloudformationSchema.zip
 *     Last-Modified: Mon, 03 Aug 2026 01:29:20 GMT
 *
 * — so `npm run --prefix lexicons/aws prepack`, which CI runs on every build and
 * any local codegen or docs task triggers, resolved to whatever CloudFormation
 * shipped that morning. During the #1312 docs work a docs-only branch twice
 * picked up a resource-count move with nothing in the commit explaining it. The
 * count was only the visible symptom; the same regeneration rewrites generated
 * types and the resource registry.
 *
 * Since there is no version to pin, the pin is over content. Specifically over
 * the **extracted schemas**, not the zip: AWS repackaging the archive changes
 * its `ETag` and its bytes while the schemas are identical, and a pin that fires
 * on that would be noise. Sorted `typeName` → `sha256(schema)`, hashed in order,
 * moves exactly when a schema does.
 *
 * Advisory is not enough here, unlike the emulator image pins (#808). An
 * emulator that drifts fails a test you can see; a spec that drifts silently
 * rewrites committed artifacts in a branch about something else. So a mismatch
 * refuses, and accepting is a deliberate act that lands as its own commit.
 */

import { createHash } from "crypto";
import pinnedTypes from "./pinned-types.json" with { type: "json" };

/**
 * The resource types the pinned archive contained.
 *
 * Committed beside the digest so accepting a new spec is reviewable as a diff:
 * the PR that moves the pin shows exactly which types AWS added or removed,
 * rather than one opaque hash replacing another. The generated artifacts cannot
 * play that role — `src/generated/` is not committed.
 */
export const PINNED_TYPE_NAMES: ReadonlySet<string> = new Set(pinnedTypes as string[]);

export interface SpecPin {
  /** `sha256:…` over the sorted typeName → schema content. */
  readonly digest: string;
  /** How many resource types the pinned archive contained. */
  readonly resources: number;
  /** ISO date the pin was accepted, so a diff reads as a decision. */
  readonly accepted: string;
}

/**
 * The accepted upstream spec.
 *
 * To move it: run generation, read the refusal, confirm the delta is one you
 * want, and paste the printed pin here in its own commit.
 */
export const AWS_SPEC_PIN: SpecPin = {
  digest: "sha256:a2d99e08c8b32a421b9e6e55f73fbdb2fa29e062e053ffdcd34de7138223b3b3",
  resources: 1650,
  accepted: "2026-08-03",
};

/** Env var that accepts whatever upstream currently serves, printing the new pin. */
export const ACCEPT_ENV = "CHANT_ACCEPT_AWS_SPEC";

/**
 * Digest the extracted schemas. Stable against repackaging; changes when any
 * schema's bytes change, or when a type is added or removed.
 */
export function specContentDigest(schemas: ReadonlyMap<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const typeName of [...schemas.keys()].sort()) {
    hash.update(typeName);
    hash.update(createHash("sha256").update(schemas.get(typeName)!).digest());
  }
  return `sha256:${hash.digest("hex")}`;
}

/** What moved between the pinned archive and the one just fetched. */
export interface SpecDrift {
  digest: string;
  resources: number;
  added: string[];
  removed: string[];
}

/** Compare a freshly fetched archive against a pin. `null` when it matches. */
export function specDrift(
  schemas: ReadonlyMap<string, Buffer>,
  pinnedNames: ReadonlySet<string> | undefined,
  pin: SpecPin = AWS_SPEC_PIN,
): SpecDrift | null {
  const digest = specContentDigest(schemas);
  if (digest === pin.digest) return null;

  const names = new Set(schemas.keys());
  return {
    digest,
    resources: names.size,
    // Type names are only known when a caller supplies the previous set;
    // without it the count delta still tells a reader the shape of the change.
    added: pinnedNames ? [...names].filter((n) => !pinnedNames.has(n)).sort() : [],
    removed: pinnedNames ? [...pinnedNames].filter((n) => !names.has(n)).sort() : [],
  };
}

/** The refusal a mismatch produces, or the acceptance notice under {@link ACCEPT_ENV}. */
export function driftMessage(drift: SpecDrift, pin: SpecPin = AWS_SPEC_PIN): string {
  const delta = drift.resources - pin.resources;
  const countLine =
    delta === 0
      ? `${drift.resources} resource types, unchanged in count`
      : `${drift.resources} resource types, ${delta > 0 ? "+" : ""}${delta} against the pin`;

  const lines = [
    "The upstream CloudFormation schema has moved since the pinned one.",
    "",
    `  pinned    ${pin.digest}  (${pin.resources} resources, accepted ${pin.accepted})`,
    `  upstream  ${drift.digest}  (${countLine})`,
  ];

  if (drift.added.length > 0) {
    lines.push(`  added     ${drift.added.slice(0, 5).join(", ")}${drift.added.length > 5 ? ` (+${drift.added.length - 5} more)` : ""}`);
  }
  if (drift.removed.length > 0) {
    lines.push(`  removed   ${drift.removed.slice(0, 5).join(", ")}${drift.removed.length > 5 ? ` (+${drift.removed.length - 5} more)` : ""}`);
  }

  lines.push(
    "",
    "Generation refuses rather than regenerating against a spec nobody chose:",
    "a docs or codegen task on an unrelated branch would otherwise rewrite the",
    "generated types and resource registry with no commit saying why.",
    "",
    "To accept it, confirm the delta is one you want and update the pin in",
    "lexicons/aws/src/spec/pin.ts, in its own commit:",
    "",
    `  digest: "${drift.digest}",`,
    `  resources: ${drift.resources},`,
    `  accepted: "<today>",`,
    "",
    `Or re-run with ${ACCEPT_ENV}=1 to proceed this once and print the same block.`,
  );

  return lines.join("\n");
}

/**
 * Refuse a fetched archive that does not match the pin.
 *
 * Under {@link ACCEPT_ENV} it warns with the same detail instead, so the
 * accept-then-paste loop is one command rather than two.
 */
export function assertPinnedSpec(
  schemas: ReadonlyMap<string, Buffer>,
  options: {
    pin?: SpecPin;
    /** Defaults to {@link PINNED_TYPE_NAMES}; overridden in tests. */
    pinnedNames?: ReadonlySet<string>;
    env?: NodeJS.ProcessEnv;
    warn?: (message: string) => void;
  } = {},
): void {
  const pin = options.pin ?? AWS_SPEC_PIN;
  const drift = specDrift(schemas, options.pinnedNames ?? PINNED_TYPE_NAMES, pin);
  if (!drift) return;

  const message = driftMessage(drift, pin);
  const env = options.env ?? process.env;
  if (env[ACCEPT_ENV]) {
    (options.warn ?? ((m: string) => console.error(m)))(message);
    return;
  }
  throw new Error(message);
}
