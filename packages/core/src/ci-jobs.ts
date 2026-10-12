/**
 * The job primitives chant's three CI generators share (#3765): the scheduled
 * Op pipeline (`generateOpsPipeline`), the Op waves pipeline
 * (`generateOpWavesPipeline`) and the component pipeline (`chant build
 * --components --generate`, with `--pr-loop`, `--wave-gate` and
 * `--promote-to`). Each forge lexicon builds its documents from these, so a
 * trigger, a token, a permission rule or an image default is decided once:
 *
 *  - the image a generated job runs in, {@link CI_IMAGE};
 *  - the branches a trigger filters on, {@link triggerBranches};
 *  - the job token and secret expressions of GitHub Actions and Forgejo
 *    Actions, {@link GITHUB_JOB_TOKEN} and {@link githubSecret};
 *  - the `permissions:` a finding-mode needs and the rules for adding to it,
 *    {@link permissionsFor} and {@link mergePermissions};
 *  - the `setup` steps and `environment` a job may carry, checked once per
 *    forge ({@link assertSetupSteps}, {@link assertEnvironment},
 *    {@link gitlabSetupScript}, {@link assertGitlabEnvironment});
 *  - GitLab's `rules:` expressions and `id_tokens:` declaration.
 *
 * The Forgejo dialect (action refs, dropped `permissions:` and
 * `environment:`, the header note naming what was dropped) is the forgejo
 * lexicon's, in its `components/ci-jobs.ts`, since the transform it applies
 * lives there.
 */

import type { OpEnvironment, OpFindingMode, OpSetupStep, OpTrigger } from "./lexicon";

// ── Every forge ─────────────────────────────────────────────────────────────

/**
 * The image every generated job runs in unless the caller names another. It
 * carries node and npm, which `chant` needs, and git, which a job that reads
 * the base commit or pushes to `chant/lifecycle` needs (#3789).
 */
export const CI_IMAGE = "node:22";

/**
 * The branch a `push` trigger filters on when it names none. A generator
 * works from a spec, not a checkout, so it cannot read a project's real
 * default branch; a project on another one names it.
 */
export const DEFAULT_BRANCH = "main";

/**
 * The branches a push trigger filters on: the ones given, or
 * {@link DEFAULT_BRANCH} when none are. An empty list is none, on every
 * forge.
 */
export function pushBranches(branches: readonly string[] | undefined): string[] {
  return branches && branches.length > 0 ? [...branches] : [DEFAULT_BRANCH];
}

/**
 * The branches a trigger filters on: a `pull_request` trigger's list, or
 * undefined for every branch; a `push` trigger's, with {@link pushBranches}'
 * default; none for `cron`.
 */
export function triggerBranches(trigger: OpTrigger): string[] | undefined {
  switch (trigger.kind) {
    case "cron":
      return undefined;
    case "pull_request":
      return trigger.branches && trigger.branches.length > 0 ? [...trigger.branches] : undefined;
    case "push":
      return pushBranches(trigger.branches);
  }
}

/** A job id every forge accepts, from a kebab- or camel-cased name. */
export function ciJobName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** A command template with each `{name}` part filled in. */
export function fillCommand(template: readonly string[], name: string): string[] {
  return template.map((part) => part.replace("{name}", name));
}

/** `{ [key]: map }` when the map has an entry, else `{}`: for spreading an optional mapping into a document. */
export function nonEmpty<K extends string, V>(key: K, map: Record<string, V> | undefined): { [P in K]?: Record<string, V> } {
  return map && Object.keys(map).length > 0 ? ({ [key]: map } as { [P in K]: Record<string, V> }) : {};
}

/**
 * A job's `environment:` mapping. Always the mapping form, never the string
 * shorthand, so adding a `url` later is a new key rather than a reshaped
 * value. GitHub and GitLab read the same two keys.
 */
export function environmentDoc(environment: OpEnvironment): { name: string; url?: string } {
  return { name: environment.name, ...(environment.url === undefined ? {} : { url: environment.url }) };
}

/** The directory part of a relative path, `.` when there is none. */
export function dirnameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "." : path.slice(0, i);
}

// ── GitHub Actions and Forgejo Actions ──────────────────────────────────────

/** The runner label a generated job asks for; the Forgejo dialect rewrites it to the project's label. */
export const GITHUB_RUNNER = "ubuntu-latest";

/** The job token, which GitHub and Forgejo both mint for every run. */
export const GITHUB_JOB_TOKEN = "${{ github.token }}";

/** A repository secret, by name. */
export function githubSecret(name: string): string {
  return `\${{ secrets.${name} }}`;
}

/**
 * A repository secret, or the job token when the secret is unset (#3624). An
 * unset secret reads as the empty string, so a workflow generated for a
 * production token still runs in a fork or a fresh repository, with what the
 * job token may do.
 */
export function githubSecretOrJobToken(name: string): string {
  return `\${{ secrets.${name} || github.token }}`;
}

/** Each name mapped from the repository secret of the same name. */
export function githubSecretEnv(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((n) => [n, githubSecret(n)]));
}

/**
 * Least-privilege `permissions:` for a finding-mode. `report` needs no write
 * access; `issue` needs only `issues: write`; `pull-request` (and
 * `merge-request`, generated the same way when a GitLab-authored spec is
 * targeted at github) needs `contents: write` to push the reconcile branch
 * plus `pull-requests: write` to open the PR. `comment` changes nothing in
 * the repository, so its whole scope is `{ contents: read, pull-requests:
 * write }`.
 */
export function permissionsForMode(mode: OpFindingMode): Record<string, "read" | "write"> {
  switch (mode) {
    case "issue":
      return { contents: "read", issues: "write" };
    case "comment":
      return { contents: "read", "pull-requests": "write" };
    case "pull-request":
    case "merge-request":
      return { contents: "write", "pull-requests": "write" };
    case "report":
      return { contents: "read" };
  }
}

/**
 * {@link permissionsForMode} on a trigger. A `pull_request` trigger reports
 * its finding as a comment on the triggering PR itself (#2084): any mode but
 * `report` posts something to act on a finding, so on that trigger every
 * such mode also gets `pull-requests: write` for the comment.
 */
export function permissionsFor(mode: OpFindingMode, trigger: OpTrigger): Record<string, "read" | "write"> {
  const base = permissionsForMode(mode);
  if (trigger.kind === "pull_request" && mode !== "report") return { ...base, "pull-requests": "write" };
  return base;
}

/**
 * Every scope `GITHUB_TOKEN` accepts in a workflow's `permissions:` mapping,
 * kebab-cased as GitHub spells them. An additive scope outside this set is
 * refused by name rather than emitted: GitHub ignores an unknown key, so
 * `id_token` or `idToken` would generate a workflow that looks like it grants
 * OIDC and hands the run no token at all.
 */
export const GITHUB_TOKEN_SCOPES: ReadonlySet<string> = new Set([
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
]);

/**
 * Merge a spec's additive `permissions` over the finding-mode's own set
 * (#2242), refusing by name anything that is not strictly additive:
 *
 *  - a blanket `write-all`/`read-all`, in either the key or the value
 *    position, which is the exact thing {@link permissionsForMode} exists to
 *    avoid;
 *  - a scope GitHub does not define ({@link GITHUB_TOKEN_SCOPES}), because
 *    GitHub ignores the key and the run silently gets nothing;
 *  - a scope the mode already grants, at any value — additive means additive,
 *    so this can neither downgrade `contents: write` to read nor restate it.
 *    A mode whose set is wrong is fixed by changing the mode, where the
 *    scope and the behavior that spends it stay together;
 *  - `pull-requests: write` on a trigger with no pull request. Pull-request
 *    access is what the finding-modes own: `pull-request` grants it together
 *    with the `contents: write` needed to push the branch first, and
 *    `comment` grants it on the one trigger that carries a pull request to
 *    comment on. Adding it beside a mode that posts nothing, on a cron or
 *    push run, grants write access no step in the generated job can spend.
 */
export function mergePermissions(
  name: string,
  base: Record<string, "read" | "write">,
  additive: Record<string, "read" | "write">,
  trigger: OpTrigger,
): Record<string, "read" | "write"> {
  const merged: Record<string, "read" | "write"> = { ...base };
  for (const [rawScope, value] of Object.entries(additive)) {
    const scope = rawScope.trim();
    const where = `Scheduled Op "${name}" adds permission "${scope}: ${value}"`;
    if (scope === "write-all" || scope === "read-all" || String(value).endsWith("-all")) {
      throw new Error(
        `${where}, a blanket grant. \`permissions\` on a scheduled Op is additive over the ` +
          `least-privilege set its finding-mode needs, one named scope at a time. Name the scopes the ` +
          `job actually spends (e.g. { "id-token": "write" }).`,
      );
    }
    if (!GITHUB_TOKEN_SCOPES.has(scope)) {
      throw new Error(
        `${where}, which is not a GITHUB_TOKEN permission scope. GitHub ignores an unrecognized key, so ` +
          `this would emit a workflow that reads as granted and hands the run nothing. Known scopes: ` +
          `${[...GITHUB_TOKEN_SCOPES].sort().join(", ")}.`,
      );
    }
    if (scope in base) {
      throw new Error(
        `${where}, but its finding-mode already grants "${scope}: ${base[scope]}". These permissions are ` +
          `additive only — they never replace, widen or downgrade a scope the mode computed. Change the ` +
          `Op's findingMode if that set is wrong, and add only scopes no mode grants (e.g. "id-token").`,
      );
    }
    if (scope === "pull-requests" && trigger.kind !== "pull_request") {
      throw new Error(
        `${where}, but this Op's trigger is "${trigger.kind}", which carries no pull request. Pull-request ` +
          `write access belongs to a finding-mode: "pull-request" grants it with the contents: write its ` +
          `branch push needs, and "comment" grants it on the pull_request trigger. Set findingMode instead ` +
          `of adding the scope here.`,
      );
    }
    merged[scope] = value;
  }
  return merged;
}

/**
 * Refs that name an action repository's own default branch. A generated
 * workflow is committed once and then re-run unattended, often over a cloud
 * role, so "whatever was pushed to that repo last" is not a version — the
 * code that assumes the role can change between the run somebody reviewed and
 * the next one. A release channel the action's author cuts deliberately (`v6`,
 * `v6.2.4`, `stable`) or a commit sha is a version, and both pass.
 */
const DEFAULT_BRANCH_REFS = new Set(["main", "master", "head", "default"]);

/** `owner/repo` or `owner/repo/subpath`, then `@ref`. */
const USES_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[A-Za-z0-9_.-]+)*)@([^\s@]+)$/;

/**
 * Validate a `setup` list for GitHub or Forgejo Actions (#2242). A `run`
 * entry needs a non-empty line and nothing else. A `uses` entry has to be a
 * pinned `owner/repo[/subpath]@ref`: no bare `owner/repo`, since an unpinned
 * action resolves to its default branch, and no ref in
 * {@link DEFAULT_BRANCH_REFS} for the same reason spelled out loud. Local
 * (`./path`) and container (`docker://`) refs are refused too — they are
 * legal GitHub Actions, but the generator emits a workflow into a repository
 * it has never seen, so it cannot know a local path resolves there.
 */
export function assertSetupSteps(name: string, setup: OpSetupStep[]): void {
  setup.forEach((step, index) => {
    const where = `Scheduled Op "${name}" setup step ${index + 1}`;
    if ("uses" in step) {
      const ref = step.uses.trim();
      const match = USES_PATTERN.exec(ref);
      if (!match) {
        throw new Error(
          `${where} has \`uses: "${step.uses}"\`, which is not a pinned action reference. ` +
            `Write it as owner/repo@ref (optionally owner/repo/subpath@ref), e.g. ` +
            `"aws-actions/configure-aws-credentials@v6". A local "./path" or "docker://" ref is not ` +
            `accepted here: this generator emits a workflow into a repository it cannot inspect, so it ` +
            `has no way to tell whether such a ref resolves there.`,
        );
      }
      const gitRef = match[4];
      if (DEFAULT_BRANCH_REFS.has(gitRef.toLowerCase())) {
        throw new Error(
          `${where} pins \`uses: "${step.uses}"\` to "${gitRef}", the action repository's own default ` +
            `branch, which names whatever was pushed there last rather than a version. A generated ` +
            `workflow is committed once and re-run unattended, often over a cloud role, so pin a release ` +
            `tag or a commit sha instead (e.g. "${match[1]}/${match[2]}@v1" or "@<40-char sha>").`,
        );
      }
      return;
    }
    if (step.run.trim() === "") {
      throw new Error(`${where} has an empty \`run\` line. Give it a command, or drop the entry.`);
    }
  });
}

/** One setup entry as a GitHub Actions step: `with:` and `env:` only when they hold something. */
export function setupStepDoc(step: OpSetupStep): Record<string, unknown> {
  if ("uses" in step) {
    return {
      uses: step.uses,
      ...nonEmpty("with", step.with),
      ...nonEmpty("env", step.env),
    };
  }
  return { run: step.run, ...nonEmpty("env", step.env) };
}

/**
 * Validate an `environment` for GitHub Actions (#2257). GitHub creates an
 * environment it has never seen on first use rather than failing the run,
 * and an environment created that way carries no protection rules at all —
 * so a job can name one and read as gated while being gated by nothing.
 * Neither the generator nor GitHub can tell those apart at build time, which
 * is why what is refused here is only the shape that could never bind: a
 * name that is blank, and a `url` that is neither absolute nor an expression
 * the forge resolves.
 */
export function assertEnvironment(name: string, environment: OpEnvironment): void {
  const where = `Scheduled Op "${name}" environment`;
  if (environment.name.trim() === "") {
    throw new Error(
      `${where} has an empty \`name\`. An environment is named repository configuration — the ` +
        `protection rules and reviewers live on the environment, not in this workflow — so there is ` +
        `nothing for a blank name to resolve to. Give it the environment's name, or drop the option.`,
    );
  }
  if (environment.url === undefined) return;
  const url = environment.url.trim();
  if (url === "") {
    throw new Error(`${where} "${environment.name}" has an empty \`url\`. Omit the field rather than setting it to "".`);
  }
  if (!/^https?:\/\//.test(url) && !url.includes("${{")) {
    throw new Error(
      `${where} "${environment.name}" has \`url: "${environment.url}"\`, which is neither an absolute ` +
        `http(s) URL nor a \${{ }} expression. GitHub renders this value as the deployment's own link, ` +
        `so a relative path becomes a dead link on the environment page rather than an error anywhere. ` +
        `Write the full URL, or an expression the run resolves to one.`,
    );
  }
}

// ── GitLab CI ───────────────────────────────────────────────────────────────

/** The pipeline source GitLab reports for a merge-request pipeline. */
export const GITLAB_MERGE_REQUEST_SOURCE = '$CI_PIPELINE_SOURCE == "merge_request_event"';

/** The pipeline source GitLab reports for a pipeline schedule. */
export const GITLAB_SCHEDULE_SOURCE = '$CI_PIPELINE_SOURCE == "schedule"';

/** A job variable that makes the runner clone the whole history, which a job reading the base commit needs. */
export const GITLAB_FULL_HISTORY = { GIT_DEPTH: "0" } as const;

/** The `rules:` if-expression for a push to `branch`, a quoted name or an expression such as `$CI_DEFAULT_BRANCH`. */
export function gitlabPushRule(branch: string): string {
  return `$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == ${branch}`;
}

/**
 * Refuse a branch name that cannot be interpolated into a `rules:`
 * if-expression. The expression is a string GitLab parses, so a `"` would end
 * it early and a `$` would expand as a variable — either one silently changes
 * which pipelines match the job, which is worse than not generating it.
 * `subject` names what filters, such as `Scheduled Op "apply"`.
 */
export function assertGitlabBranch(subject: string, branch: string): void {
  if (branch.trim() === "") {
    throw new Error(`${subject} has an empty branch filter. Name a branch, or drop the filter.`);
  }
  if (/["$\\]/.test(branch)) {
    throw new Error(
      `${subject} filters on branch "${branch}", which carries a character this generator ` +
        `cannot put in a GitLab \`rules:\` expression: a quote would end the expression early and a "$" ` +
        `would expand as a CI/CD variable, either of which silently changes which pipelines run the job. ` +
        `Name a branch without \`"\`, \`$\` or \`\\\`.`,
    );
  }
}

/**
 * One `rules:` entry per branch a trigger filters on, each checked by
 * {@link assertGitlabBranch}. Two or more branches are two or more entries:
 * `rules:` is an OR over its list, which is how GitLab spells the alternation
 * github expresses as a `branches:` array. A cron trigger is selected by
 * `selector`, the CI/CD variable a pipeline schedule sets, and the Op's name.
 */
export function gitlabRules(subject: string, trigger: OpTrigger, selector: { variable: string; value: string }): Array<{ if: string }> {
  switch (trigger.kind) {
    case "cron":
      return [{ if: `${GITLAB_SCHEDULE_SOURCE} && $${selector.variable} == "${selector.value}"` }];
    case "pull_request": {
      const branches = triggerBranches(trigger);
      if (!branches) return [{ if: GITLAB_MERGE_REQUEST_SOURCE }];
      return branches.map((branch) => {
        assertGitlabBranch(subject, branch);
        return { if: `${GITLAB_MERGE_REQUEST_SOURCE} && $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "${branch}"` };
      });
    }
    case "push":
      return pushBranches(trigger.branches).map((branch) => {
        assertGitlabBranch(subject, branch);
        return { if: gitlabPushRule(JSON.stringify(branch)) };
      });
  }
}

/**
 * The `id_tokens:` entry an `id-token: write` spec gets. The name is the
 * environment variable the JWT lands in, which the job's own setup line reads
 * (`aws sts assume-role-with-web-identity --web-identity-token
 * "$CHANT_ID_TOKEN"`, or the provider's equivalent).
 *
 * `$CI_SERVER_URL` as the audience is GitLab's own documented default: an
 * identity provider federated to a GitLab instance is registered with that
 * instance's URL as its audience, and the variable expands to exactly that on
 * gitlab.com and on a self-managed instance alike.
 */
export const GITLAB_ID_TOKEN_NAME = "CHANT_ID_TOKEN";
export const GITLAB_ID_TOKEN_AUDIENCE = "$CI_SERVER_URL";

/**
 * Turn additive `permissions` (#2242) into the one GitLab declaration that
 * carries the same meaning, refusing everything else by name.
 *
 * `id-token: write` is that one: GitLab's OIDC surface is `id_tokens:`, a
 * per-job declaration of a JWT the job exchanges for cloud credentials
 * itself. `id-token: read` is refused rather than mapped, because GitLab
 * either mints the token into the job or does not. Every other scope is
 * refused: GitLab has no per-job token-scope mapping at all, and a scope
 * quietly dropped would emit a job that reads as granted and runs with
 * nothing.
 */
export function gitlabIdTokens(name: string, permissions: Record<string, "read" | "write"> | undefined): Record<string, unknown> | undefined {
  let wantsIdToken = false;
  for (const [rawScope, value] of Object.entries(permissions ?? {})) {
    const scope = rawScope.trim();
    if (scope === "id-token") {
      if (value !== "write") {
        throw new Error(
          `Scheduled Op "${name}" adds permission "id-token: ${value}", but GitLab either mints an ` +
            `OIDC token into a job or does not — there is no read-only half of an \`id_tokens:\` ` +
            `declaration. Ask for { "id-token": "write" }, or drop the option.`,
        );
      }
      wantsIdToken = true;
      continue;
    }
    throw new Error(
      `Scheduled Op "${name}" adds permission "${scope}: ${value}", but GitLab CI has no per-job ` +
        `token-scope mapping — there is no \`permissions:\` key to add it to (#2242). The one scope that ` +
        `does cross over is "id-token": "write", which becomes an \`id_tokens:\` declaration. Drop the ` +
        `option here, or generate this Op for github.`,
    );
  }
  return wantsIdToken ? { [GITLAB_ID_TOKEN_NAME]: { aud: GITLAB_ID_TOKEN_AUDIENCE } } : undefined;
}

/**
 * A `setup` list as GitLab `script:` lines. A `uses` entry is a GitHub
 * Actions marketplace action, which GitLab has no shape for, so it is refused
 * by name rather than dropped. `subject` names whose setup it is, such as
 * `Scheduled Op "apply"`.
 */
export function gitlabSetupScript(subject: string, setup: readonly OpSetupStep[] | undefined): string[] {
  return (setup ?? []).map((step, index) => {
    if ("uses" in step) {
      throw new Error(
        `${subject} setup step ${index + 1} is \`uses: "${step.uses}"\`, a GitHub Actions ` +
          `marketplace action. GitLab CI jobs run \`script\` lines only, so there is nothing to translate it ` +
          `into (#2242). Express the setup as a \`{ run }\` entry, or generate it for github/forgejo.`,
      );
    }
    return step.run;
  });
}

/**
 * Validate an `environment` on GitLab's own terms (#2257). A GitLab job
 * naming an environment that does not exist creates an unprotected one on
 * first deploy rather than failing, so the only shapes worth refusing at
 * build time are the ones that could never bind: a blank name, and a `url`
 * that is neither absolute nor a variable expression GitLab expands, which
 * would render as a dead "View deployment" link.
 */
export function assertGitlabEnvironment(name: string, environment: OpEnvironment): void {
  const where = `Scheduled Op "${name}" environment`;
  if (environment.name.trim() === "") {
    throw new Error(
      `${where} has an empty \`name\`. A GitLab environment is a project object, and its approval ` +
        `rules live on that object rather than in this file, so a blank name resolves to nothing. ` +
        `Give it the environment's name, or drop the option.`,
    );
  }
  if (environment.url === undefined) return;
  const url = environment.url.trim();
  if (url === "") {
    throw new Error(`${where} "${environment.name}" has an empty \`url\`. Omit the field rather than setting it to "".`);
  }
  if (!/^https?:\/\//.test(url) && !url.includes("$")) {
    throw new Error(
      `${where} "${environment.name}" has \`url: "${environment.url}"\`, which is neither an absolute ` +
        `http(s) URL nor a variable expression GitLab expands. It becomes the environment's own link, ` +
        `so a relative path is a dead link on the environment page rather than an error anywhere.`,
    );
  }
}
