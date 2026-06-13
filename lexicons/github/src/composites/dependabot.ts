/**
 * Dependency-update configuration (`.github/dependabot.yml`) as a chant
 * resource, so it is emitted and lintable like workflows (#294).
 *
 * Two failure modes the post-synth checks target:
 *   - an update that executes untrusted code from a freshly-pulled dependency
 *     during the update itself (`insecure-external-code-execution: allow`), and
 *   - a configuration with no cooldown — a version published seconds ago
 *     (including a compromised one) is adopted before anyone can react.
 *
 * The `Dependabot` composite ships safe defaults: a cooldown window and an
 * explicit deny on external code execution.
 */

import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

/** A single `updates:` entry in dependabot.yml. */
export interface DependabotUpdate {
  /** e.g. "npm", "pip", "github-actions", "docker". */
  packageEcosystem: string;
  /** Directory to scan (defaults to "/"). */
  directory?: string;
  directories?: string[];
  /** Update schedule. */
  schedule: { interval: "daily" | "weekly" | "monthly"; day?: string; time?: string };
  /** Cooldown window — delay adopting freshly-published versions. */
  cooldown?: {
    defaultDays?: number;
    semverMajorDays?: number;
    semverMinorDays?: number;
    semverPatchDays?: number;
  };
  /** Cap on concurrent update PRs. */
  openPullRequestsLimit?: number;
  /** Whether to run a dependency's lifecycle scripts during the update. */
  insecureExternalCodeExecution?: "allow" | "deny";
  /** Passthrough for the rest of the dependabot update schema. */
  [key: string]: unknown;
}

export interface DependabotConfigProps {
  version?: number;
  updates: DependabotUpdate[];
  registries?: Record<string, unknown>;
}

/** The `.github/dependabot.yml` resource. */
export class DependabotConfig implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "github";
  readonly entityType = "GitHub::Dependabot::Config";
  readonly kind = "resource" as const;
  readonly props: DependabotConfigProps;

  constructor(props: DependabotConfigProps) {
    this.props = { version: 2, ...props };
  }
}

export interface DependabotEcosystem {
  packageEcosystem: string;
  directory?: string;
  interval?: "daily" | "weekly" | "monthly";
}

export interface DependabotProps {
  /** Ecosystems to keep updated. */
  ecosystems: DependabotEcosystem[];
  /** Cooldown window in days before adopting a freshly-published version (default 7). */
  cooldownDays?: number;
  /** Cap on concurrent update PRs per ecosystem (default 5). */
  openPullRequestsLimit?: number;
}

/**
 * Build a `DependabotConfig` with safe defaults: a cooldown window on every
 * ecosystem and external code execution explicitly denied.
 */
export function Dependabot(props: DependabotProps): DependabotConfig {
  const cooldownDays = props.cooldownDays ?? 7;
  const limit = props.openPullRequestsLimit ?? 5;
  const updates: DependabotUpdate[] = props.ecosystems.map((e) => ({
    packageEcosystem: e.packageEcosystem,
    directory: e.directory ?? "/",
    schedule: { interval: e.interval ?? "weekly" },
    cooldown: { defaultDays: cooldownDays },
    openPullRequestsLimit: limit,
    insecureExternalCodeExecution: "deny",
  }));
  return new DependabotConfig({ version: 2, updates });
}
