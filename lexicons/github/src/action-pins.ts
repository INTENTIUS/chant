/**
 * The action versions the github lexicon emits. The table is core's
 * (`@intentius/chant/action-pins`, #4403); this file reads it, so an update is
 * one change there (#4410). Each action here is its newest row in core's table,
 * pinned at the commit of its latest release.
 *
 * Composites emit `<slug>@<sha> # <version>` by default, the form GHA021 and
 * GHA029 accept and GHA059 reads the version label from. The serializer writes
 * the `# <version>` part as a YAML comment, so GitHub sees only the SHA. With
 * `pin: "tag"` they emit the major tag (`actions/checkout@v7`).
 *
 * Refresh a row in core by resolving the release tag to its commit:
 *
 *   gh api repos/actions/checkout/commits/v7.0.1 --jq .sha
 */

import { ACTION_PINS as CORE_PINS, type ActionPin as CorePin } from "@intentius/chant/action-pins";

export interface ActionPin {
  /** The major tag `pin: "tag"` emits, such as `v7`. */
  major: string;
  /** The release the SHA belongs to, written as the pin's comment. */
  version: string;
  /** The full commit SHA of `version`. */
  sha: string;
}

const SLUGS = [
  "actions/checkout",
  "actions/setup-node",
  "actions/setup-go",
  "actions/setup-python",
  "actions/cache",
  "actions/upload-artifact",
  "actions/download-artifact",
  "oven-sh/setup-bun",
  "golangci/golangci-lint-action",
  "docker/login-action",
  "docker/setup-buildx-action",
  "docker/metadata-action",
  "docker/build-push-action",
] as const;

export type PinnedAction = (typeof SLUGS)[number];

/** The newest row of core's table for `slug`. */
function newest(slug: string): ActionPin {
  const rows = (Object.values(CORE_PINS) as CorePin[]).filter((p) => p.slug === slug);
  if (rows.length === 0) throw new Error(`action-pins: core's table has no row for ${slug}`);
  const row = rows.reduce((a, b) => (Number(b.major.slice(1)) > Number(a.major.slice(1)) ? b : a));
  return { major: row.major, version: row.tag, sha: row.sha };
}

export const ACTION_PINS = Object.fromEntries(SLUGS.map((s) => [s, newest(s)])) as Record<PinnedAction, ActionPin>;

/**
 * How a composite refers to its action: `"sha"` (the default) emits the pinned
 * commit with its version as a comment (`actions/checkout@3d3c…90b1 # v7.0.1`),
 * `"tag"` emits the major tag (`actions/checkout@v7`).
 */
export type ActionPinMode = "tag" | "sha";

/** The `uses:` value for a pinned action. */
export function actionRef(slug: PinnedAction, pin: ActionPinMode = "sha"): string {
  const entry = ACTION_PINS[slug];
  return pin === "sha" ? `${slug}@${entry.sha} # ${entry.version}` : `${slug}@${entry.major}`;
}

/** The pin table entry for an action slug, if the lexicon maintains one. */
export function actionPin(slug: string): ActionPin | undefined {
  return Object.prototype.hasOwnProperty.call(ACTION_PINS, slug) ? ACTION_PINS[slug as PinnedAction] : undefined;
}

const COMPOSITE_FOR: Partial<Record<PinnedAction, string>> = {
  "actions/checkout": "Checkout",
  "actions/setup-node": "SetupNode",
};

/**
 * The exact fix a pinning warning names for an action in the pin table, or
 * an empty string for any other action.
 */
export function pinFixHint(slug: string): string {
  if (!actionPin(slug)) return "";
  const pinned = slug as PinnedAction;
  const composite = COMPOSITE_FOR[pinned];
  const how = composite ? `, which ${composite}({ pin: "sha" }) emits` : "";
  return ` Use \`uses: ${actionRef(pinned, "sha")}\`${how}.`;
}
