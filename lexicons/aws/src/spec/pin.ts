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
  digest: "sha256:30bca5721afaaa891d17f528af4bc9b2fc5f707e34e5c6c78d3afeb6f0f259b8",
  resources: 1651,
  accepted: "2026-08-04",
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
export function driftMessage(
  drift: SpecDrift,
  pin: SpecPin = AWS_SPEC_PIN,
  options: { fatal?: boolean } = {},
): string {
  const fatal = options.fatal ?? true;
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

  if (fatal) {
    lines.push(
      "",
      "Generation refuses rather than regenerating against a spec nobody chose:",
      "a docs or codegen task on an unrelated branch would otherwise rewrite the",
      "generated types and resource registry with no commit saying why.",
    );
  } else {
    // chant #1473 — the type set is identical, so this is upstream editing
    // schemas in place, not a spec swap. Generation continues; whether it
    // changed anything visible is decided by the surface snapshot.
    lines.push(
      "",
      "The resource set is unchanged, so this is upstream editing schemas in",
      "place rather than a different spec. Generation continues — whether it",
      "changed the published API is decided by surface.snapshot.json, which is",
      "checked against the generated artifacts before anything is packed.",
    );
  }

  lines.push(
    "",
    "To refresh the pin, confirm the delta is one you want and update",
    "lexicons/aws/src/spec/pin.ts, in its own commit:",
    "",
    `  digest: "${drift.digest}",`,
    `  resources: ${drift.resources},`,
    `  accepted: "<today>",`,
  );

  if (fatal) {
    lines.push("", `Or re-run with ${ACCEPT_ENV}=1 to proceed this once and print the same block.`);
  }

  return lines.join("\n");
}

/**
 * Refuse a fetched archive whose RESOURCE SET does not match the pin.
 *
 * Under {@link ACCEPT_ENV} it warns with the same detail instead, so the
 * accept-then-paste loop is one command rather than two.
 *
 * ## Why byte drift alone is a warning (chant #1473)
 *
 * This originally threw on any digest mismatch, which made the aws lexicon
 * unpublishable. `prepack` runs `generate`, `generate` fetches from upstream,
 * and CloudFormation republishes individual schemas several times a day: three
 * distinct digests were observed on 2026-08-03 alone, all with an unchanged
 * count of 1650, and two fetches two hours apart differed in 4 of 1650 files.
 * `chant-v0.39.0` published 13 packages and failed on aws for exactly this,
 * with a pin ~18 hours old.
 *
 * A pin that goes stale by itself within hours cannot gate a release: it does
 * not distinguish "someone regenerated against a spec nobody chose" from
 * "AWS edited a description this afternoon".
 *
 * So the two cases are separated:
 *
 *  - **The resource set moved** (a type added or removed) — still a refusal.
 *    That always changes the published API, and it is the case #1390 was filed
 *    about.
 *  - **Only bytes moved**, with an identical type set — a warning. Whether it
 *    matters is decided downstream by the surface gate in core's
 *    `validateLexiconArtifacts`, which compares the generated API against the
 *    committed `surface.snapshot.json`. That gate is exact: a byte change that
 *    alters the emitted surface fails the build, and one that does not is
 *    correctly ignored.
 *
 * The guarantee is unchanged in substance — nothing ships whose surface was
 * not reviewed — and it is now enforced against the thing that actually
 * matters rather than against an archive that is not stable enough to pin.
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
  const pinnedNames = options.pinnedNames ?? PINNED_TYPE_NAMES;
  const drift = specDrift(schemas, pinnedNames, pin);
  if (!drift) return;

  const env = options.env ?? process.env;
  const warn = options.warn ?? ((m: string) => console.error(m));

  if (env[ACCEPT_ENV]) {
    warn(driftMessage(drift, pin));
    return;
  }

  // chant #1473 — an identical type set with different bytes is upstream
  // churn, not an unchosen spec. Reported so a stale pin stays visible, but
  // not fatal; the surface gate decides whether it changed anything.
  //
  // Guarded on actually HAVING a previous type set: `specDrift` reports empty
  // added/removed when it has nothing to compare against, which would
  // otherwise read as "no type moved" and downgrade every mismatch.
  const typeSetKnown = pinnedNames !== undefined && pinnedNames.size > 0;
  const typeSetMoved = drift.added.length > 0 || drift.removed.length > 0;

  if (typeSetKnown && !typeSetMoved) {
    warn(driftMessage(drift, pin, { fatal: false }));
    return;
  }

  throw new Error(driftMessage(drift, pin));
}
