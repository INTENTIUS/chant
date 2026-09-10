/**
 * Generate mode — scheduled Op → Forgejo Actions workflow YAML (#927).
 *
 * The forgejo counterpart to the github Op generator
 * (`@intentius/chant-lexicon-github/components/generate-op-pipeline`, #927),
 * exactly like `./generate-pipeline.ts` is the forgejo counterpart to
 * github's component generator (#969). Reuses github's
 * `buildGithubOpPipelineDocs` to build the same cron-trigger/concurrency/job
 * structure, then applies the Forgejo dialect ({@link transformWorkflowObject})
 * before emitting.
 *
 * One difference from the component generator: Forgejo Actions ignores
 * `permissions:` entirely (the dialect drops it wherever it appears, see
 * ../dialect.ts's `DROPPED_KEYS`), so this omits the section outright rather
 * than emitting a control the runner can't act on. The token a finding-mode
 * needs still rides the trigger step's `env:` (`GH_TOKEN`/`GITHUB_TOKEN`,
 * built by github's generator); actual write access on Forgejo is a property
 * of the runner/token configuration, not the workflow YAML.
 *
 * That covers a spec's additive `permissions` too (#2242): an `id-token:
 * write` added for OIDC is dropped here along with the mode's own scopes,
 * because the Forgejo runner reads none of them and issues no OIDC token off
 * a workflow permission. A Forgejo job authenticates to a cloud provider
 * through whatever the runner already holds. A spec's `setup` steps do cross
 * over unchanged: Forgejo runs `uses:` steps, so they are emitted in the
 * position github puts them (after the checkout, ahead of the `beforeScript`
 * lines) with the dialect's own action-ref rewrite applied — an action with
 * no mapping in ../actions.ts passes through verbatim and resolves only if
 * the runner can fetch it.
 *
 * `comment` (#2231) crosses over, since chant #2291: it posts onto the
 * triggering pull request by shelling to `gh` against `${GITHUB_API_URL}`,
 * and a Forgejo Actions job already sets that (and `github.token`) the same
 * way a GitHub Actions job does. This generator used to refuse the mode by
 * name here, on the premise that chant had no way to point `gh` at a Forgejo
 * instance; that premise was checked against a real Forgejo
 * 12.0.4+gitea-1.22.0 instance during INTENTIUS/choudoufu#1027 and found
 * false — the failure was `gh api` resolving a *relative* path against
 * `/api/v3`, which Forgejo does not serve, not an unreachable forge. See
 * `reconcilePr`'s `postOrUpdateComment` (`packages/core/src/op/activities/reconcile.ts`)
 * for the fix.
 *
 * `issue` (`gh issue create`/`postOrUpdateGithubIssue`) does not cross over,
 * and chant #2315 is why: it remained un-refused-but-unverified after #2304
 * lifted `comment`'s refusal, and settling that gap the same way — against a
 * real instance rather than a mock — found a real failure, so the refusal
 * below is reinstated rather than lifted. Tested against the same
 * 12.0.4+gitea-1.22.0 image (`codeberg.org/forgejo/forgejo:12`) with a repo,
 * an issue, and a pull request created on it: the *read* half of
 * `postOrUpdateGithubIssue` checks out fine on Forgejo — plain paginated
 * `GET .../issues?state=open` (no `/search/issues`, confirmed absent from a
 * live Forgejo's own OpenAPI spec) returns pull requests interleaved with
 * issues exactly as GitHub's endpoint does, and the `.pull_request == null`
 * filter and the marker `startswith` match both behave identically to
 * GitHub. The *write* half did not: `postOrUpdateGithubIssue`'s POST and
 * PATCH calls carried only `GH_TOKEN` (in fact, on the `issue` path, not even
 * that — `reconcilePr` handed it `execAsync` with no `env` override at all,
 * chant #2320), and `gh`'s own documented environment variables (`gh help
 * environment`) scope `GH_TOKEN`/`GITHUB_TOKEN` to "github.com or a subdomain
 * of ghe.com" — never a self-hosted Forgejo. A `GH_DEBUG=api` POST against
 * the live instance, with `GH_TOKEN` and `GITHUB_API_URL` set exactly as the
 * generated workflow sets them, sent no `Authorization` header at all and
 * Forgejo answered `{"message":"token is required"}` (HTTP 401); adding
 * `GH_HOST` alongside `GH_TOKEN` made no difference. The same shape was what
 * `postOrUpdateComment`'s writes carried too, which is why #2304's "verified
 * against a real Forgejo instance" could not have gone through the generated
 * workflow's own credential path — either that session had a `gh auth login`
 * already stored for the test instance, which a real Actions job's fresh
 * checkout never has, or a different `gh` build was in play.
 *
 * Chant #2333 fixed that credential for both modes: `ghCredentialEnv` now
 * forwards the resolved token as `GH_ENTERPRISE_TOKEN` beside `GH_TOKEN`,
 * which is the variable `gh` reads for a host in neither of the two classes
 * above. #2333's own probe against the same image also narrowed the claim
 * made here: `GH_ENTERPRISE_TOKEN` authenticated the identical call *without*
 * a `GH_HOST` beside it, because the full URL #2291 built already names the
 * host. So the premise this refusal was reinstated on no longer holds, and
 * both halves of `postOrUpdateGithubIssue` — the paginated read and the
 * POST/PATCH write — were driven green end to end against a live
 * 12.0.4+gitea-1.22.0 instance under #2333, from a shell with no stored
 * `gh auth login`.
 *
 * The refusal below is nonetheless left standing here, because lifting it is
 * a generator behavior change with its own YAML surface to settle and #2333
 * was scoped to the credential. Lifting it is filed separately; this comment
 * is corrected rather than acted on so the stated reason does not outlive the
 * fact it rested on.
 *
 * A spec's `environment` (#2257) is dropped on the same terms as
 * `permissions:`, and for a stronger reason: Forgejo Actions has no
 * environments at all — no protection rules, no required reviewers, no
 * per-environment secrets — so the key names an object that does not exist on
 * the instance. Dropping it silently would be the worst outcome available,
 * because the whole point of the option is a human holding an apply, so this
 * also writes a comment into the generated file's header saying which
 * environment was asked for and that nothing on Forgejo enforces it. What
 * still holds the apply here is chant's own gate (#2119), which is a fact on
 * the `chant/lifecycle` branch and needs nothing from the forge.
 *
 * The gated-apply notice job (#2243) does not cross over either, for the same
 * reason and by the same mechanism as `permissions:`: it shells to `gh`, which
 * a Forgejo `act_runner` neither ships nor can point at its own instance, and
 * it runs outside the Op's container image, where a hosted GitHub runner's
 * preinstalled tools would be. So the doc rebuilt below simply does not carry
 * `gatedNoticeDoc`, and the job is dropped. What does cross over is the half
 * that needs no forge API: a `push` job still runs with `--gated-exit 0`, so a
 * Forgejo apply that stops at its gate is a green run rather than a red one,
 * and `chant run` still writes the gate and the approve command to
 * `GITHUB_STEP_SUMMARY`, which Forgejo Actions sets like GitHub does.
 *
 * The gate-notice job's own reason for being — `outputs: { gated, op, gate,
 * approve }` on the Op's job, and the `node -e` step that writes them to
 * `$GITHUB_OUTPUT` — does not survive it either (#2294). Both existed only for
 * that job to read via `needs.<job>.outputs`; with the job gone, so is every
 * reader, and `buildGithubOpPipelineDocs` is asked for neither
 * (`emitGatedOutputs: false` below) rather than emitting them here and
 * stripping them back out. Should the Forgejo posting work in #2291 grow a
 * notice job of its own, this is the one flag that brings both back.
 *
 * A spec's own `variables` (#2290) crosses over unchanged: forgejo reuses the
 * same job-level `env:` github's builder emits, and the dialect transform
 * touches only `permissions:`/`environment:`/action refs, never a job's `env:`
 * mapping. That is what makes a per-Op credential expressible here at all —
 * `ComponentPipelineOptions.variables` is workflow-scoped and, on Forgejo,
 * Actions mints no OIDC token to put in `setup` instead, so a job-level
 * `variables` entry is the only way one Op's job can hold a credential no
 * sibling Op's job receives.
 */

import {
  buildGithubOpPipelineDocs,
  emitOpPipelineYAML,
  type GithubOpPipelineDoc,
} from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import type {
  ComponentPipelineOptions,
  OpPipelineResult,
  ScheduledOpSpec,
} from "@intentius/chant/lexicon";
import { transformWorkflowObject, type ForgejoDialectOptions } from "../dialect";

/** Apply the Forgejo dialect to one section of a pipeline doc. */
function forgejoize(value: Record<string, unknown>, dialect: ForgejoDialectOptions): Record<string, unknown> {
  return transformWorkflowObject(value, dialect).value as Record<string, unknown>;
}

/**
 * Strip the job-level `environment:` github emitted (#2257). Forgejo Actions
 * has no environments, so the key would read as a deployment gate and hold
 * nothing back. Dropped from the rebuilt doc rather than from the dialect's
 * own `DROPPED_KEYS`, so this touches the Op generator alone and leaves every
 * other document the dialect transforms exactly as it emits today.
 */
function withoutEnvironment(jobsDoc: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(jobsDoc).map(([jobName, job]) => {
      if (typeof job !== "object" || job === null || !("environment" in job)) return [jobName, job];
      const { environment: _dropped, ...rest } = job as Record<string, unknown>;
      return [jobName, rest];
    }),
  );
}

/** Say in the generated file which environment gate did not survive the crossing. */
function droppedEnvironmentHeader(environmentName: string): string[] {
  return [
    `# chant dropped \`environment: ${environmentName}\` from this workflow: Forgejo Actions has no`,
    "# environments, so there is no protection rule, required reviewer or wait timer for the key to",
    "# name. This job is not held back by anything on the forge. What still stops the apply is chant's",
    "# own gate: the run records a pending fact on the chant/lifecycle branch and ends, and `chant",
    "# approve <op> <gate>` is what lets the next run through.",
  ];
}

/**
 * Synthesize one `.forgejo/workflows/*.yml` per scheduled Op. Reuses github's
 * trigger/job structure ({@link buildGithubOpPipelineDocs}) — its `setup`-step
 * and additive-permission validation included, so an unpinned action ref is
 * refused here on the same terms — then applies the Forgejo dialect and drops
 * `permissions:` (ignored by the Forgejo runner).
 * Wired into core's Op generate mode via the forgejo lexicon plugin's
 * `generateOpPipeline` (../plugin.ts).
 */
export function generateForgejoOpPipeline(
  ops: ScheduledOpSpec[],
  options: ComponentPipelineOptions = {},
  dialectOptions: ForgejoDialectOptions = {},
): OpPipelineResult {
  // `findingMode: "comment"` used to be refused by name here (#2231); lifted
  // in #2291 once a real Forgejo instance showed the forge itself was never
  // the obstacle — see the module doc above.

  // `findingMode: "issue"` is refused by name here (#2315): unlike `comment`,
  // a real Forgejo instance did not clear it — see the module doc above for
  // the reproduction.
  for (const spec of ops) {
    if (spec.findingMode === "issue") {
      throw new Error(
        `Scheduled Op "${spec.name}" has findingMode "issue", which opens or edits a GitHub-shaped issue by ` +
          `shelling to \`gh\`. Checked against a real Forgejo 12.0.4+gitea-1.22.0 instance (chant #2315): the ` +
          `search this mode does works there, but the POST/PATCH it writes with does not — \`gh\`'s own ` +
          `GH_TOKEN/GITHUB_TOKEN only authenticate a request to github.com or a ghe.com subdomain, never a ` +
          `self-hosted Forgejo, and neither this mode nor its caller sets GH_HOST or GH_ENTERPRISE_TOKEN, so ` +
          `every write fails with Forgejo's "token is required" (HTTP 401). Use findingMode "comment" on a ` +
          `pull_request trigger here, or generate this Op for github.`,
      );
    }
  }

  // `emitGatedOutputs: false` (#2294): forgejo never carries a gate-notice job
  // (`gatedNoticeDoc` never crosses the dialect, below), so the job outputs
  // and the `node -e` step that populate them would have no reader.
  const { files, jobs } = buildGithubOpPipelineDocs(ops, options, { emitGatedOutputs: false });

  return {
    // One file per spec, in spec order, which is what lets the header below
    // read its Op's own `environment` off the input by position.
    files: files.map(({ name, doc }, index) => {
      const environment = ops[index].environment;
      const forgejoDoc: GithubOpPipelineDoc = {
        ...(environment ? { header: droppedEnvironmentHeader(environment.name) } : {}),
        on: forgejoize(doc.on, dialectOptions),
        ...(doc.env ? { env: forgejoize(doc.env, dialectOptions) } : {}),
        concurrency: forgejoize(doc.concurrency, dialectOptions),
        permissions: {},
        jobsDoc: forgejoize(withoutEnvironment(doc.jobsDoc), dialectOptions),
      };
      return { name, yaml: emitOpPipelineYAML(forgejoDoc) };
    }),
    jobs,
  };
}
