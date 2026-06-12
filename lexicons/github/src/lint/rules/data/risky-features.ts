/**
 * Vendored snapshot of GitHub Actions features with a known security or
 * safety footgun, matched against emitted workflow YAML by GHA054.
 *
 * Advisory and necessarily incomplete. Refresh source: GitHub changelog
 * deprecations and security hardening guidance. Editing this list is the
 * refresh mechanism; a stale entry only weakens detection, never blocks a build.
 */
export interface RiskyFeature {
  /** Pattern matched against the emitted YAML. */
  pattern: RegExp;
  /** Short label for the footgun. */
  label: string;
  /** What to do instead. */
  advice: string;
}

export const RISKY_FEATURES: readonly RiskyFeature[] = [
  {
    pattern: /::set-output\s/,
    label: "deprecated ::set-output:: workflow command",
    advice: "write to $GITHUB_OUTPUT instead",
  },
  {
    pattern: /::save-state\s/,
    label: "deprecated ::save-state:: workflow command",
    advice: "write to $GITHUB_STATE instead",
  },
  {
    pattern: /ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION/,
    label: "opt-in to an end-of-life Node.js runtime",
    advice: "upgrade the action to a supported Node runtime instead of forcing the unsupported one",
  },
  {
    pattern: /::add-mask::\$\{\{/,
    label: "masking a dynamic value after it may have already been logged",
    advice: "mask secrets at their source; ::add-mask:: on an interpolated value can leak before the mask applies",
  },
];
