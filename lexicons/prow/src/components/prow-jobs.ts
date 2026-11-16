/**
 * What the prow generators share (#5189): one chant job as a Prow job.
 *
 * A generator describes each job as a {@link ProwJobSpec}. The spec holds the
 * job's kind and shell lines, and the values those lines read.
 * {@link renderProwJob} turns it into the job Prow loads: a decorated
 * kubernetes job whose one container runs the lines in `sh`.
 *
 * The generators keep the rule PROW104 and PROW105 check. A presubmit runs a
 * pull request's code. It holds no credential at all and runs on the
 * untrusted build cluster. Merged code runs in postsubmits and periodics,
 * which may hold one. The renderer refuses a presubmit with a credential, and
 * the settings refuse one cluster for both, so no generator writes either by
 * mistake.
 *
 * Values come from Prow's own job variables, as chant reads them in a Prow
 * job (#5170). A presubmit has `PULL_BASE_SHA`, `PULL_NUMBER` and
 * `PULL_PULL_SHA`. A postsubmit has `PULL_BASE_SHA` and `PULL_BASE_REF`.
 * Each job keeps its report in `$ARTIFACTS`, which a decorated job uploads.
 */

import type { ProwPipelineSettings } from "@intentius/chant/lexicon";

/** The Prow job kinds. */
export type ProwJobKind = "presubmit" | "postsubmit" | "periodic";

/** A Secret's name and key. */
export interface SecretKey {
  name: string;
  key: string;
}

/** The settings with their defaults applied. */
export interface ProwSettings {
  untrustedCluster: string;
  trustedCluster: string;
  tokenSecret: SecretKey;
  runnerKeySecret: SecretKey;
  serviceAccounts: { plan?: string; apply?: string };
}

/** The default build cluster for presubmits. */
export const UNTRUSTED_CLUSTER = "untrusted";
/** The default build cluster for postsubmits and periodics. */
export const TRUSTED_CLUSTER = "trusted";
/** The default Secret the GitHub token is read from. */
export const TOKEN_SECRET: SecretKey = { name: "chant-github-token", key: "token" };
/** The default Secret `CHANT_RUNNER_KEY` is read from, when it exists. */
export const RUNNER_KEY_SECRET: SecretKey = { name: "chant-runner-key", key: "key" };

/** The container every generated job runs its lines in. */
export const CONTAINER_NAME = "chant";

/** The settings with defaults, refused when the presubmits would share a cluster with the credentials. */
export function resolveProwSettings(settings: ProwPipelineSettings = {}): ProwSettings {
  const untrustedCluster = settings.untrustedCluster ?? UNTRUSTED_CLUSTER;
  const trustedCluster = settings.trustedCluster ?? TRUSTED_CLUSTER;
  if (untrustedCluster === trustedCluster) {
    throw new Error(`prow.untrustedCluster and prow.trustedCluster are both ${untrustedCluster}; presubmits run pull request code, so they run on a build cluster where no job holds a credential (PROW105)`);
  }
  for (const [field, s] of [["tokenSecret", settings.tokenSecret], ["runnerKeySecret", settings.runnerKeySecret]] as const) {
    if (s && (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(s.name) || !/^[-._a-zA-Z0-9]+$/.test(s.key))) {
      throw new Error(`prow.${field} names Secret ${JSON.stringify(s.name)} with key ${JSON.stringify(s.key)}, and a Secret's name is lower-case letters, digits, "-" and "." and its key letters, digits, "-", "_" and "."`);
    }
  }
  return {
    untrustedCluster,
    trustedCluster,
    tokenSecret: settings.tokenSecret ?? TOKEN_SECRET,
    runnerKeySecret: settings.runnerKeySecret ?? RUNNER_KEY_SECRET,
    serviceAccounts: settings.serviceAccounts ?? {},
  };
}

/** One generated job, before it is a Prow job. */
export interface ProwJobSpec {
  kind: ProwJobKind;
  name: string;
  /** The job's `annotations.description`. */
  description: string;
  /** The shell lines, run in order in one `sh -e`. */
  lines: string[];
  /**
   * The values the lines read, by variable name, as a GitHub generator spells
   * them. Each becomes an `export` before the lines, or for a credential a
   * variable of the container read from its Secret ({@link prowValue}).
   */
  env?: Record<string, string>;
  /** Directories and files the job keeps in `$ARTIFACTS`, relative to where its lines run. */
  keep?: string[];
  /** The service account a postsubmit's or periodic's pod runs as. */
  serviceAccount?: string;
  /** One run at a time. */
  serial?: boolean;
  /** A periodic's cron. */
  cron?: string;
  /** The branches the job runs for when they are not the context's branch. Empty means every branch. */
  branches?: string[];
}

/** What a generator renders every job with. */
export interface ProwRenderContext {
  settings: ProwSettings;
  /** The repository's `owner/name`. */
  repo: string;
  /** The branch presubmits and postsubmits run for. */
  branch: string;
  image: string;
  /** Plain variables every job's container holds, such as `CHANT_ENV`. */
  variables: Record<string, string>;
  /** The setup and `beforeScript` lines, which every job runs before its own. */
  before?: string[];
  /** Lines every job runs after its lines: `extraScript`. */
  after?: string[];
  /** A workspace member's directory, relative to the repository root. The job's lines run there. */
  dir?: string;
}

/** A shell word in single quotes, or as it is when it needs none. */
export function shQuote(value: string): string {
  return /^[A-Za-z0-9._\/=:@+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A branch name as the anchored regular expression Prow's `branches` takes. */
export function branchPattern(branch: string): string {
  return `^${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** Where a value comes from in a Prow job. */
export type ProwValue = { shell: string } | { secret: "token" | "runnerKey" };

/**
 * The Prow form of a value a GitHub generator writes. A GitHub expression
 * becomes the Prow job variable that holds the same thing. The job token and
 * the runner key are read from Secrets. A plain value stays as it is. An
 * expression with no Prow form is refused, so none reaches a job config.
 */
export function prowValue(name: string, value: string): ProwValue {
  if (!value.includes("${{")) return { shell: shQuote(value) };
  const expr = value.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  switch (expr) {
    case "github.event.pull_request.base.sha":
      return { shell: '"$PULL_BASE_SHA"' };
    case "github.event.pull_request.number":
      return { shell: '"$PULL_NUMBER"' };
    case "github.event.pull_request.head.sha":
      return { shell: '"$PULL_PULL_SHA"' };
    // Prow names a postsubmit's own commit and no earlier one, so the record's line measures from the branch.
    case "github.event.before":
      return { shell: "''" };
    case "github.sha":
      return { shell: '"$(git rev-parse HEAD)"' };
    case "github.token":
    case "secrets.GITHUB_TOKEN":
      return { secret: "token" };
    case "secrets.CHANT_RUNNER_KEY":
      return { secret: "runnerKey" };
  }
  throw new Error(`${name} reads ${value}, which has no Prow form; a Prow job reads a Secret through its pod spec, so pass it another way`);
}

/** The lines that make the checkout clonerefs left usable by git, with `origin` naming the repository. */
function checkoutLines(repo: string, credential: boolean): string[] {
  return [
    'git config --global --add safe.directory "$PWD" 2>/dev/null || true',
    `git remote get-url origin >/dev/null 2>&1 || git remote add origin ${shQuote(`https://github.com/${repo}.git`)}`,
    // The token reaches git through a helper that reads it when git asks, so it is never written to the config.
    ...(credential ? [`git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'`] : []),
  ];
}

/** The line that copies what a job keeps into `$ARTIFACTS` when the job exits. */
function keepLine(keep: readonly string[]): string {
  const paths = keep.map(shQuote).join(" ");
  return `trap 'if [ -n "\${ARTIFACTS:-}" ]; then mkdir -p "$ARTIFACTS"; for p in ${paths}; do [ ! -e "$p" ] || cp -R "$p" "$ARTIFACTS/"; done; fi' EXIT`;
}

type Job = Record<string, unknown>;

/** The Prow job for `spec`. Throws for a presubmit that would read a Secret or run as a service account. */
export function renderProwJob(spec: ProwJobSpec, ctx: ProwRenderContext): Job {
  const exports: string[] = [];
  const secrets = new Map<string, "token" | "runnerKey">();
  for (const [name, value] of Object.entries(spec.env ?? {})) {
    const v = prowValue(name, value);
    if ("secret" in v) secrets.set(name, v.secret);
    else exports.push(`export ${name}=${v.shell}`);
  }
  const credential = secrets.size > 0 || spec.serviceAccount !== undefined;
  if (spec.kind === "presubmit" && credential) {
    throw new Error(`presubmit ${spec.name} would hold ${[...secrets.keys(), ...(spec.serviceAccount ? [`service account ${spec.serviceAccount}`] : [])].join(", ")}, and a presubmit runs the pull request's code (PROW104); chant writes that job as a postsubmit or a periodic`);
  }
  const lines = [...spec.lines];
  // A line written for GitHub Actions reads the job's commit from GITHUB_SHA.
  const sha = [...lines, ...(ctx.before ?? [])].some((l) => l.includes("$GITHUB_SHA")) ? ['GITHUB_SHA="$(git rev-parse HEAD)"; export GITHUB_SHA'] : [];
  const script = [
    "set -e",
    ...checkoutLines(ctx.repo, [...secrets.values()].includes("token")),
    ...(ctx.dir && ctx.dir !== "." ? [`cd ${shQuote(ctx.dir)}`] : []),
    ...(spec.keep?.length ? [keepLine(spec.keep)] : []),
    ...sha,
    ...(ctx.before ?? []),
    ...exports,
    ...lines,
    ...(ctx.after ?? []),
  ].join("\n");

  const env: Array<Record<string, unknown>> = [
    ...Object.entries(ctx.variables).map(([name, value]) => ({ name, value })),
    ...[...secrets.entries()].map(([name, which]) => {
      const s = which === "token" ? ctx.settings.tokenSecret : ctx.settings.runnerKeySecret;
      // The runner key signs the run record when the Secret is there; without it the run is unsigned, as on GitHub.
      return { name, valueFrom: { secretKeyRef: { name: s.name, key: s.key, ...(which === "runnerKey" ? { optional: true } : {}) } } };
    }),
  ];
  const podSpec: Job = {
    ...(spec.serviceAccount ? { serviceAccountName: spec.serviceAccount } : { automountServiceAccountToken: false }),
    containers: [{ name: CONTAINER_NAME, image: ctx.image, command: ["/bin/sh", "-c"], args: [script], ...(env.length > 0 ? { env } : {}) }],
  };
  const cluster = spec.kind === "presubmit" ? ctx.settings.untrustedCluster : ctx.settings.trustedCluster;
  const [org, name] = ctx.repo.split("/");
  return {
    name: spec.name,
    cluster,
    ...(spec.kind === "presubmit" ? { always_run: true } : {}),
    decorate: true,
    ...(spec.serial ? { max_concurrency: 1 } : {}),
    ...(spec.kind === "periodic"
      ? { cron: spec.cron, extra_refs: [{ org, repo: name, base_ref: ctx.branch, workdir: true }] }
      : spec.branches?.length === 0
        ? {}
        : { branches: (spec.branches ?? [ctx.branch]).map(branchPattern) }),
    annotations: { description: spec.description },
    spec: podSpec,
  };
}

/** A job name Prow takes: lower-case letters, digits and `-`, from chant's names. */
export function prowJobName(...parts: Array<string | undefined>): string {
  return parts
    .filter((p): p is string => p !== undefined && p !== "")
    .map((p) => p.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
    .join("-");
}
