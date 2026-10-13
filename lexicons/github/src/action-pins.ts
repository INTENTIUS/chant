/**
 * The action versions the github lexicon emits, and the commit each release
 * tag points at.
 *
 * Composites emit `<slug>@<major>` by default. With `pin: "sha"` they emit
 * `<slug>@<sha> # <version>`, the form GHA021 and GHA029 accept and GHA059
 * reads the version label from. The serializer writes the `# <version>` part
 * as a YAML comment, so GitHub sees only the SHA.
 *
 * Refresh a row by resolving the release tag to its commit:
 *
 *   gh api repos/actions/checkout/commits/v7.0.1 --jq .sha
 *
 * Keep `major` on a version whose action runs on a Node runtime GitHub still
 * supports.
 */

export interface ActionPin {
  /** The major tag composites emit by default, such as `v7`. */
  major: string;
  /** The release the SHA belongs to, written as the pin's comment. */
  version: string;
  /** The full commit SHA of `version`. */
  sha: string;
}

export const ACTION_PINS = {
  "actions/checkout": {
    major: "v7",
    version: "v7.0.1",
    sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
  },
  "actions/setup-node": {
    major: "v7",
    version: "v7.0.0",
    sha: "820762786026740c76f36085b0efc47a31fe5020",
  },
} as const satisfies Record<string, ActionPin>;

export type PinnedAction = keyof typeof ACTION_PINS;

/**
 * How a composite refers to its action: `"tag"` emits the major tag
 * (`actions/checkout@v7`), `"sha"` emits the pinned commit with its version
 * as a comment (`actions/checkout@3d3c…90b1 # v7.0.1`).
 */
export type ActionPinMode = "tag" | "sha";

/** The `uses:` value for a pinned action. */
export function actionRef(slug: PinnedAction, pin: ActionPinMode = "tag"): string {
  const entry: ActionPin = ACTION_PINS[slug];
  return pin === "sha" ? `${slug}@${entry.sha} # ${entry.version}` : `${slug}@${entry.major}`;
}

/** The pin table entry for an action slug, if the lexicon maintains one. */
export function actionPin(slug: string): ActionPin | undefined {
  return Object.prototype.hasOwnProperty.call(ACTION_PINS, slug)
    ? ACTION_PINS[slug as PinnedAction]
    : undefined;
}

const COMPOSITE_FOR: Record<PinnedAction, string> = {
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
  return ` Use \`uses: ${actionRef(pinned, "sha")}\`, which ${COMPOSITE_FOR[pinned]}({ pin: "sha" }) emits.`;
}
