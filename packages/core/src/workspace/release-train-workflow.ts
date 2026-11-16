/**
 * The release workflow of a train (#5154): `chant release workflow` at a
 * workspace root whose `chant.config.ts` declares `release.train` and
 * `release.workflow`. The root's members release separately, each at its
 * own label, and one run releases every member that changed.
 *
 * With `trigger: "dispatch"` a person starts it with the levels (default
 * `auto`, the levels the commits and intent files give), and three jobs
 * follow:
 *
 * - gate: the commit to release, as a dispatched release picks it (`chant ci
 *   last-green`, or the dispatched commit under `gate: "head"`).
 * - cut: `chant workspace train cut <env> --at <commit> --levels <levels>
 *   --yes`, which picks the members, labels each past every version it
 *   already has, cuts them, records the train and pushes the member tags
 *   and `release-train/<env>/<id>` in one push. A commit with nothing to
 *   release ends the run here.
 * - publish: in a checkout of the commit, `chant workspace train prepare`
 *   (stamp each member, build the packages they need), the build, and
 *   `chant workspace train publish <env> <id> --yes`, which stages, runs the
 *   members' `release.verify`, and reveals layer by layer.
 *
 * The publish job also runs on a pushed `release-train/<env>/*` tag, so a
 * train cut from a workstation with `chant workspace train cut <env> --yes`
 * publishes from the same file. With the tag trigger (the default) that is
 * the whole workflow. A tag the job's own token pushed starts nothing, so a
 * dispatched run publishes in its own publish job.
 */
import { tagComments } from "../action-pins";
import type { ReleaseGreenSource } from "../lifecycle/release-green";
import { field, gateScript, githubSetup, LEDGER_FETCH_FIRST, type JobExtras, type ReleaseWorkflowForge } from "./release-workflow";

export interface TrainWorkflowInput {
  forge: Exclude<ReleaseWorkflowForge, "gitlab">;
  env: string;
  trigger: "dispatch" | "tag";
  chant: string;
  install: string | null;
  build: string | null;
  root: string | null;
  /** `chant workspace train publish`'s flags: `--require-provenance` under `supply-chain`, and `--yes`. */
  flags: string;
  after: string[];
  /** The toolchain steps of the gate (Node, for chant) and of the jobs that build (#5152). */
  chantSetup: string[];
  fullSetup: string[];
  extra: JobExtras;
  /** The publish job's `GITHUB_TOKEN` line for a GitHub forge target, or nothing. */
  forgeToken: string[];
  /** The cut job's `GITHUB_TOKEN` line under `forge-checks` (#5149), or nothing. */
  cutToken?: string[];
  green: ReleaseGreenSource;
  gate: "last-green" | "head";
  lane?: string;
}

/** The tag a train's cut pushes, as a GitHub tag filter: `*` stops at `/`, so a member's own tag starts nothing. */
export function trainTagFilter(env: string): string {
  return `release-train/${env}/*`;
}

/** GitHub and Forgejo: the train workflow (#5154). */
export function renderTrainWorkflow(o: TrainWorkflowInput): string {
  const defaults = o.root ? ["    defaults:", "      run:", `        working-directory: ${o.root}`] : [];
  const run = (l: string) => `      - run: ${l}`;
  const block = (lines: string[]): string[] => ["        run: |", ...lines.map((l) => `          ${l}`)];
  const installLines = o.install ? [run(o.install)] : [];
  const ciFetch = run("git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'");
  const ledgerFetch = run("git fetch origin chant/lifecycle:chant/lifecycle");
  const dispatch = o.trigger === "dispatch";
  const env = o.env;
  const lines = [
    "name: chant release train",
    "on:",
    ...(dispatch
      ? [
          "  workflow_dispatch:",
          "    inputs:",
          "      levels:",
          "        description: auto for the levels the commits and intent files give, a level for every member (major, minor or patch), or <member>=<level>, separated by spaces",
          "        required: false",
          "        default: auto",
          "        type: string",
        ]
      : []),
    "  push:",
    `    tags: [${JSON.stringify(trainTagFilter(env))}]`,
    "permissions:",
    "  contents: write",
    "  id-token: write",
    ...o.extra.permissions,
    "concurrency:",
    "  group: chant-release",
    "  cancel-in-progress: false",
    "jobs:",
  ];
  if (dispatch) {
    lines.push(
      "  gate:",
      "    if: github.event_name == 'workflow_dispatch'",
      "    runs-on: ubuntu-latest",
      ...defaults,
      "    outputs:",
      "      commit: ${{ steps.green.outputs.commit }}",
      "    steps:",
      ...githubSetup(undefined, o.chantSetup),
      ...installLines,
      ciFetch,
      "      - id: green",
      ...block([...gateScript(o, "$GITHUB_SHA"), 'echo "commit=$commit" >> "$GITHUB_OUTPUT"']),
      "  cut:",
      "    needs: gate",
      "    runs-on: ubuntu-latest",
      ...defaults,
      "    outputs:",
      "      train: ${{ steps.cut.outputs.train }}",
      ...o.extra.githubEnv(["      CHANT_RELEASE_COMMIT: ${{ needs.gate.outputs.commit }}", "      CHANT_RELEASE_LEVELS: ${{ inputs.levels }}", ...(o.cutToken ?? [])]),
      "    steps:",
      ...githubSetup("${{ needs.gate.outputs.commit }}", o.fullSetup),
      ...installLines,
      ...o.extra.githubSteps,
      ciFetch,
      run(LEDGER_FETCH_FIRST),
      "      - id: cut",
      ...block([
        'git config user.name "chant release"',
        'git config user.email "chant-release@localhost"',
        `${o.chant} workspace train cut ${env} --at "$CHANT_RELEASE_COMMIT" --levels "\${CHANT_RELEASE_LEVELS:-auto}" --yes --json > "$RUNNER_TEMP/chant-train.json"`,
        `echo "train=$(${field("d.train?.id")} "$RUNNER_TEMP/chant-train.json")" >> "$GITHUB_OUTPUT"`,
      ]),
    );
  }
  const publishIf = dispatch ? "    if: ${{ always() && (github.event_name == 'push' || (needs.cut.result == 'success' && needs.cut.outputs.train != '')) }}" : null;
  const trainFromRef = `echo "CHANT_RELEASE_TRAIN=\${CHANT_RELEASE_TRAIN:-\${GITHUB_REF_NAME#release-train/${env}/}}" >> "$GITHUB_ENV"`;
  lines.push(
    "  publish:",
    ...(dispatch ? ["    needs: [gate, cut]", publishIf!] : []),
    "    runs-on: ubuntu-latest",
    ...defaults,
    ...o.extra.githubEnv([...(dispatch ? ["      CHANT_RELEASE_TRAIN: ${{ needs.cut.outputs.train }}"] : []), ...o.forgeToken]),
    "    steps:",
    ...githubSetup(dispatch ? "${{ needs.gate.outputs.commit || github.sha }}" : undefined, o.fullSetup),
    ...installLines,
    ...o.extra.githubSteps,
    ciFetch,
    ledgerFetch,
    run(trainFromRef),
    run(`${o.chant} workspace train prepare ${env} "$CHANT_RELEASE_TRAIN"`),
    ...(o.build ? [run(o.build)] : []),
    run('git config user.name "chant release"'),
    run('git config user.email "chant-release@localhost"'),
    run(`${o.chant} workspace train publish ${env} "$CHANT_RELEASE_TRAIN" ${o.flags}`),
  );
  if (o.after.length > 0) {
    lines.push(
      "  after-release:",
      `    needs: ${dispatch ? "[gate, cut, publish]" : "publish"}`,
      ...(dispatch ? ["    if: ${{ always() && needs.publish.result == 'success' }}"] : []),
      "    runs-on: ubuntu-latest",
      ...defaults,
      ...(dispatch ? ["    env:", "      CHANT_RELEASE_TRAIN: ${{ needs.cut.outputs.train }}"] : []),
      "    steps:",
      ...githubSetup(dispatch ? "${{ needs.gate.outputs.commit || github.sha }}" : undefined, o.fullSetup),
      run(trainFromRef),
      ...installLines,
      ...o.after.map(run),
    );
  }
  return tagComments(`${lines.join("\n")}\n`);
}
