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
 *   release ends the run here. A cut that recorded a train and whose JSON
 *   names no train id fails the job, so the publish is never skipped
 *   silently.
 * - publish: in a checkout of the commit, `chant workspace train prepare`
 *   (stamp each member, build the packages they need), the build, and
 *   `chant workspace train publish <env> <id> --yes`, which stages, runs the
 *   members' `release.verify`, and reveals layer by layer.
 *
 * Dispatched with `train`, a recorded train's id, the gate and the cut are
 * skipped and the publish job publishes that train from its tag's commit,
 * resuming what an earlier run staged or revealed: the way to finish a
 * publish that stopped or was skipped, with no new cut and no tag pushed.
 *
 * The publish job also runs on a pushed `release-train/<env>/*` tag, so a
 * train cut from a workstation with `chant workspace train cut <env> --yes`
 * publishes from the same file. With the tag trigger (the default) that is
 * the whole workflow. A tag the job's own token pushed starts nothing, so a
 * dispatched run publishes in its own publish job.
 */
import { tagComments } from "../action-pins";
import type { ReleaseGreenSource } from "../lifecycle/release-green";
import { gateScript, githubSetup, LEDGER_FETCH_FIRST, type JobExtras, type ReleaseWorkflowForge } from "./release-workflow";

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

/**
 * The cut step's script that reads the train id from the cut's JSON. It exits
 * 1 when the file is not JSON, or names members cut and no train, so a train
 * that was cut and recorded is never left unpublished by a skipped job. A
 * file that is not JSON may still hold the id, and the error names it.
 */
export function trainIdScript(file: string): string {
  const js = [
    'const t=require("fs").readFileSync(process.argv[1],"utf8");',
    "let d;",
    "try{d=JSON.parse(t)}catch(e){",
    'const m=/"id": *"(train-[^"]+)"/.exec(t);',
    'console.error("the train cut printed more than its JSON document, so the train id can not be read ("+e.message+")."+(m?" The cut recorded "+m[1]+": dispatch this workflow with train="+m[1]+" to publish it.":" If it recorded a train, dispatch this workflow with train=<id> to publish it."));',
    "process.exit(1)}",
    'const id=d.train?.id??"";',
    'if(!id&&d.released==null&&(d.members??[]).length>0){console.error("the train cut "+d.members.length+" member(s), and its JSON names no train id to publish");process.exit(1)}',
    "process.stdout.write(id)",
  ].join("");
  return `node -e '${js}' "${file}"`;
}

/** The ref of a train's tag, as an expression: what the publish job checks out for a dispatched `train`. */
const dispatchedTrainRef = (env: string) => `format('refs/tags/release-train/${env}/{0}', inputs.train)`;

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
          "      train:",
          "        description: a recorded train's id (train-...) to publish instead of cutting one; the gate and cut are skipped, and the publish resumes from its tag",
          "        required: false",
          "        default: \"\"",
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
      "    if: github.event_name == 'workflow_dispatch' && inputs.train == ''",
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
        `train="$(${trainIdScript("$RUNNER_TEMP/chant-train.json")})" || exit 1`,
        'echo "train=$train" >> "$GITHUB_OUTPUT"',
      ]),
    );
  }
  const publishIf = dispatch ? "    if: ${{ always() && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.train != '') || (needs.cut.result == 'success' && needs.cut.outputs.train != '')) }}" : null;
  // A dispatched `train` names the train itself, and its tag the commit to check out.
  const dispatchedTrain = "${{ inputs.train || needs.cut.outputs.train }}";
  const checkoutRef = `\${{ needs.gate.outputs.commit || (inputs.train != '' && ${dispatchedTrainRef(env)}) || github.sha }}`;
  const trainFromRef = `echo "CHANT_RELEASE_TRAIN=\${CHANT_RELEASE_TRAIN:-\${GITHUB_REF_NAME#release-train/${env}/}}" >> "$GITHUB_ENV"`;
  lines.push(
    "  publish:",
    ...(dispatch ? ["    needs: [gate, cut]", publishIf!] : []),
    "    runs-on: ubuntu-latest",
    ...defaults,
    ...o.extra.githubEnv([...(dispatch ? [`      CHANT_RELEASE_TRAIN: ${dispatchedTrain}`] : []), ...o.forgeToken]),
    "    steps:",
    ...githubSetup(dispatch ? checkoutRef : undefined, o.fullSetup),
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
      ...(dispatch ? ["    env:", `      CHANT_RELEASE_TRAIN: ${dispatchedTrain}`] : []),
      "    steps:",
      ...githubSetup(dispatch ? checkoutRef : undefined, o.fullSetup),
      run(trainFromRef),
      ...installLines,
      ...o.after.map(run),
    );
  }
  return tagComments(`${lines.join("\n")}\n`);
}
