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
 * the workflow-level `permissions:` section (the dialect drops every scope
 * but `id-token`, see ../dialect.ts), so this omits the section outright rather
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
 * triggering pull request against `${GITHUB_API_URL}`, and a Forgejo Actions
 * job already sets that (and `github.token`) the same way a GitHub Actions
 * job does. This generator used to refuse the mode by name here, on the
 * premise that chant had no way to reach a Forgejo instance; that premise
 * was checked against a real Forgejo 12.0.4+gitea-1.22.0 instance during
 * INTENTIUS/choudoufu#1027 and found false. Since chant #3757 the post goes
 * through the Forgejo client in `packages/core/src/pr-forge.ts` over `fetch`
 * rather than through `gh`, so the job's image needs no `gh` either.
 *
 * `issue` crosses over too, since chant #2351. It was refused here from
 * #2332 on, after chant #2315 drove the mode against a real Forgejo
 * 12.0.4+gitea-1.22.0 instance: the paginated read and the `.pull_request ==
 * null` filter behaved as on GitHub, but every POST and PATCH answered
 * `{"message":"token is required"}` (HTTP 401), because `gh` sends
 * `GH_TOKEN` only to github.com and `ghe.com` hosts. #2333 fixed that
 * credential, and #3757 moved the mode off `gh` onto the Forgejo client in
 * `packages/core/src/pr-forge.ts`, which sends `Authorization: token …`
 * itself. The job this emits for a cron `issue` Op is github's, unchanged:
 * the same trigger, and the same `GH_TOKEN`/`GITHUB_TOKEN` from
 * `github.token` on the run step, which is the credential the mode reads.
 * Only `permissions:` is dropped, as for every mode, so what that token may
 * write on a scheduled run is the runner's configuration.
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
 * The gated-apply notice job (#2243) crosses over since #3773. It used to
 * shell to `gh` on GitHub's hosted runner image, which a Forgejo runner
 * neither ships nor can point at its own instance, so it was dropped here
 * along with the apply job's `gated`/`op`/`gate`/`approve` outputs that
 * only it read (#2294). It now runs in the Op's own image and posts through
 * `@intentius/chant/pr-forge`, whose Forgejo client finds the pull request
 * a commit merged with `commits/{sha}/pull` and sends `Authorization: token`
 * itself. So the doc rebuilt below carries `gatedNoticeDoc` through the
 * same dialect transform as the jobs, which drops its `permissions:` the
 * way it drops every scope but `id-token`. A `push` job also still runs
 * with `--gated-exit 0`, and `chant run` still writes the gate and the
 * approve command to `GITHUB_STEP_SUMMARY`.
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
} from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import type {
  ComponentPipelineOptions,
  OpPipelineResult,
  ScheduledOpSpec,
} from "@intentius/chant/lexicon";
import { assertRunnerLabels } from "@intentius/chant/ci-jobs";
import type { ForgejoDialectOptions } from "../dialect";
import { droppedEnvironmentHeader, forgejoWorkflowDoc } from "./ci-jobs";

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
  // `findingMode: "comment"` used to be refused by name here (#2231), and
  // `findingMode: "issue"` from #2332 to #2351. Neither is now: both post
  // through the Forgejo client — see the module doc above.

  // #4616: a spec's runner is a label or a list of labels here.
  for (const spec of ops) assertRunnerLabels(`Scheduled Op "${spec.name}"`, "runner", spec.runner, "Forgejo");
  const { files, jobs } = buildGithubOpPipelineDocs(ops, options, "forgejo");

  return {
    // One file per spec, in spec order, which is what lets the header below
    // read its Op's own `environment` off the input by position.
    files: files.map(({ name, doc }, index) => {
      const environment = ops[index].environment;
      // The Op's name carries over, and the gate-notice job (#3773) takes the
      // dialect like the Op's own job.
      const header = environment ? droppedEnvironmentHeader(environment.name) : undefined;
      return { name, yaml: emitOpPipelineYAML(forgejoWorkflowDoc(doc, dialectOptions, header)) };
    }),
    jobs,
  };
}
