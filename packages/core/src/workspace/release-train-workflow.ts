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
import { ACTION_PINS, tagComments, usesRef } from "../action-pins";
import type { ReleaseGreenSource } from "../lifecycle/release-green";
import { gateScript, githubSetup, jobPermissions, LEDGER_FETCH_FIRST, type JobExtras, type ReleaseWorkflowForge } from "./release-workflow";
import { RELEASE_ARTIFACTS_ARTIFACT } from "./release-steps/artifacts";

export interface TrainWorkflowInput {
  forge: ReleaseWorkflowForge;
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
  /**
   * A member declares `release.images` or `release.artifacts` (#5216): the cut
   * job stages what the cut built with `chant workspace train artifacts -o`
   * and hands it to the publish job, which checks it (`--from`) after its
   * build. A publish with nothing handed to it (a pushed train tag, a
   * dispatched `train`) builds them again and checks them.
   */
  files?: boolean;
  /** Steps that set up goreleaser, in the cut and publish jobs, for a member's `release.artifacts` it builds (#5216); on GitLab, script lines. */
  goreleaser?: string[];
  /** GitLab: the publish signs with Sigstore, so a cut that runs the doctor gets `SIGSTORE_ID_TOKEN` to check it. */
  signing?: boolean;
  /** GitLab: entries the members' targets add under the publish job's `id_tokens:` beside `SIGSTORE_ID_TOKEN`, such as `PYPI_ID_TOKEN`. */
  idTokens?: string[];
  /** `chant release doctor` in each member before the cut (#5216): `--doctor` on the dispatched cut. */
  doctor?: boolean;
  /** `verified-releases`: `chant workspace train verify` before the publish (#5216). */
  verify?: boolean;
}

/** Where the cut job stages the members' images and files, and the publish job finds them (#5216): outside the checkout. */
const TRAIN_STAGE = "$RUNNER_TEMP/chant-release-artifacts";

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
export function trainIdScript(file: string, forge: ReleaseWorkflowForge = "github"): string {
  // How to publish a recorded train: dispatch the workflow with its id, or on GitLab run a pipeline with CHANT_RELEASE_TRAIN.
  const rerun = (id: string) => (forge === "gitlab" ? `run a pipeline with CHANT_RELEASE_TRAIN=${id}` : `dispatch this workflow with train=${id}`);
  const js = [
    'const t=require("fs").readFileSync(process.argv[1],"utf8");',
    "let d;",
    "try{d=JSON.parse(t)}catch(e){",
    'const m=/"id": *"(train-[^"]+)"/.exec(t);',
    `console.error("the train cut printed more than its JSON document, so the train id can not be read ("+e.message+")."+(m?" The cut recorded "+m[1]+": ${rerun('"+m[1]+"')} to publish it.":" If it recorded a train, ${rerun("<id>")} to publish it."));`,
    "process.exit(1)}",
    'const id=d.train?.id??"";',
    'if(!id&&d.released==null&&(d.members??[]).length>0){console.error("the train cut "+d.members.length+" member(s), and its JSON names no train id to publish");process.exit(1)}',
    "process.stdout.write(id)",
  ].join("");
  return `node -e '${js}' "${file}"`;
}

/** The ref of a train's tag, as an expression: what the publish job checks out for a dispatched `train`. */
const dispatchedTrainRef = (env: string) => `format('refs/tags/release-train/${env}/{0}', inputs.train)`;

/** The train workflow (#5154), for GitHub and Forgejo, or GitLab (#5216). */
export function renderTrainWorkflow(o: TrainWorkflowInput): string {
  if (o.forge === "gitlab") return renderGitlabTrainWorkflow(o);
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
    "  contents: read",
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
      ...jobPermissions(o.extra, { contents: "read" }, "gate"),
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
      ...jobPermissions(o.extra, { contents: "write" }, "cut"),
      ...defaults,
      "    outputs:",
      "      train: ${{ steps.cut.outputs.train }}",
      ...o.extra.githubEnv(["      CHANT_RELEASE_COMMIT: ${{ needs.gate.outputs.commit }}", "      CHANT_RELEASE_LEVELS: ${{ inputs.levels }}", ...new Set([...(o.cutToken ?? []), ...(o.doctor ? o.forgeToken : [])])]),
      "    steps:",
      ...githubSetup("${{ needs.gate.outputs.commit }}", o.fullSetup),
      ...installLines,
      ...o.extra.githubSteps,
      ...(o.goreleaser ?? []),
      ciFetch,
      run(LEDGER_FETCH_FIRST),
      "      - id: cut",
      ...block([
        'git config user.name "chant release"',
        'git config user.email "chant-release@localhost"',
        `${o.chant} workspace train cut ${env} --at "$CHANT_RELEASE_COMMIT" --levels "\${CHANT_RELEASE_LEVELS:-auto}"${o.doctor ? " --doctor" : ""} --yes --json > "$RUNNER_TEMP/chant-train.json"`,
        `train="$(${trainIdScript("$RUNNER_TEMP/chant-train.json")})" || exit 1`,
        'echo "train=$train" >> "$GITHUB_OUTPUT"',
      ]),
      ...(o.files
        ? [
            "      - if: steps.cut.outputs.train != ''",
            `        run: ${o.chant} workspace train artifacts ${env} "\${{ steps.cut.outputs.train }}" -o "${TRAIN_STAGE}"`,
            "      - if: steps.cut.outputs.train != ''",
            `        uses: ${usesRef(o.forge === "forgejo" ? ACTION_PINS.uploadArtifact3 : ACTION_PINS.uploadArtifact4)}`,
            "        with:",
            `          name: ${RELEASE_ARTIFACTS_ARTIFACT}`,
            "          path: ${{ runner.temp }}/chant-release-artifacts",
            "          if-no-files-found: error",
            "          retention-days: 1",
          ]
        : []),
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
    ...jobPermissions(o.extra, { contents: "write", "id-token": "write" }, "publish"),
    ...defaults,
    ...o.extra.githubEnv([...(dispatch ? [`      CHANT_RELEASE_TRAIN: ${dispatchedTrain}`] : []), ...o.forgeToken]),
    "    steps:",
    ...githubSetup(dispatch ? checkoutRef : undefined, o.fullSetup),
    ...installLines,
    ...o.extra.githubSteps,
    ...(o.goreleaser ?? []),
    ciFetch,
    ledgerFetch,
    run(trainFromRef),
    run(`${o.chant} workspace train prepare ${env} "$CHANT_RELEASE_TRAIN"`),
    ...(o.build ? [run(o.build)] : []),
    ...(o.files
      ? dispatch
        ? [
            "      - if: needs.cut.outputs.train != ''",
            `        uses: ${usesRef(o.forge === "forgejo" ? ACTION_PINS.downloadArtifact3 : ACTION_PINS.downloadArtifact4)}`,
            "        with:",
            `          name: ${RELEASE_ARTIFACTS_ARTIFACT}`,
            "          path: ${{ runner.temp }}/chant-release-artifacts",
            run(`${o.chant} workspace train artifacts ${env} "$CHANT_RELEASE_TRAIN" --from "${TRAIN_STAGE}"`),
          ]
        : [run(`${o.chant} workspace train artifacts ${env} "$CHANT_RELEASE_TRAIN"`)]
      : []),
    ...(o.verify ? [run(`${o.chant} workspace train verify ${env} "$CHANT_RELEASE_TRAIN"`)] : []),
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
      ...jobPermissions(o.extra, { contents: "read" }, "after"),
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

/** Where a GitLab cut job stages the members' files: GitLab keeps a job's artifacts only inside the project directory (#5216). */
const GITLAB_TRAIN_STAGE = "$CI_PROJECT_DIR/.chant-release-artifacts";
/** Where the GitLab publish job moves them, out of the checkout, before it checks out the train's commit. */
const GITLAB_TRAIN_FROM = "/tmp/chant-release-artifacts";

/**
 * GitLab (#5216). With `trigger: "dispatch"` a person runs a pipeline
 * ("Run pipeline", the API or a trigger) with `CHANT_RELEASE_LEVELS` set
 * (`auto`, or the levels): the gate names the commit, the cut job cuts the
 * train and pushes its tags with `CHANT_RELEASE_TOKEN` (a project access
 * token with `write_repository`, since a job token cannot push), and the
 * publish job publishes it. Run with `CHANT_RELEASE_TRAIN` set to a recorded
 * train's id instead, the gate and cut are left out and the publish job
 * publishes that train from its tag, resuming. The dispatched file has no
 * tag rule: the cut's own push would start a second publish of the same
 * train. With `trigger: "tag"` the file is one publish job on a pushed
 * `release-train/<env>/*` tag.
 *
 * Every job's script runs in one shell, so a variable set on one line is
 * there on the next. The publish job checks out the commit the train's tag
 * names in every case.
 */
function renderGitlabTrainWorkflow(o: TrainWorkflowInput): string {
  const env = o.env;
  const q = (l: string) => `    - ${JSON.stringify(l)}`;
  const cd = o.root ? [`cd ${o.root}`] : [];
  const install = o.install ? [o.install] : [];
  const ciFetch = "git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'";
  const ledgerFetch = "git fetch origin chant/lifecycle:chant/lifecycle";
  const auth = [
    `chant_auth="$(printf 'oauth2:%s' "$CHANT_RELEASE_TOKEN" | base64 | tr -d '\\n')"`,
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $chant_auth"',
    "unset chant_auth",
  ];
  const dispatch = o.trigger === "dispatch";
  const manual = "$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/";
  const tagRule = `$CI_COMMIT_TAG =~ /^release-train\\/${env.replace(/[.*+?^${}()|[\]\\/]/g, (c) => `\\${c}`)}\\//`;
  const cutRule = `$CHANT_RELEASE_LEVELS && ($CHANT_RELEASE_TRAIN == null || $CHANT_RELEASE_TRAIN == "") && ${manual}`;
  const variables = (vars: string[]) => ["  variables:", '    GIT_DEPTH: "0"', ...vars];
  // The train: the one the pipeline names, else the one this pipeline's cut recorded, else the tag's. Then its commit, from its tag.
  const trainLines = [
    `export CHANT_RELEASE_TRAIN="\${CHANT_RELEASE_TRAIN:-\${CHANT_TRAIN_CUT:-\${CI_COMMIT_TAG#release-train/${env}/}}}"`,
    'if [ -z "$CHANT_RELEASE_TRAIN" ]; then echo "no release train was cut or named, so there is nothing to publish"; exit 0; fi',
    `git fetch origin "refs/tags/release-train/${env}/$CHANT_RELEASE_TRAIN"`,
    "git checkout --detach FETCH_HEAD",
  ];
  const lines: string[] = [];
  if (dispatch) {
    lines.push(
      "chant-release-gate:",
      "  rules:",
      `    - if: ${cutRule}`,
      ...variables([]),
      "  artifacts:",
      "    reports:",
      "      dotenv: chant-release-gate.env",
      "  script:",
      ...[...cd, ...install, ciFetch, ...gateScript(o, "$CI_COMMIT_SHA"), 'printf \'CHANT_RELEASE_COMMIT=%s\\n\' "$commit" > "$CI_PROJECT_DIR/chant-release-gate.env"'].map(q),
      "",
      "chant-release-cut:",
      "  rules:",
      `    - if: ${cutRule}`,
      ...variables(o.extra.gitlabVariables),
      "  needs: [chant-release-gate]",
      "  artifacts:",
      ...(o.files ? ["    paths:", '      - ".chant-release-artifacts/"', "    expire_in: 1 day"] : []),
      "    reports:",
      "      dotenv: chant-release-train.env",
      ...(o.doctor && o.signing ? ["  id_tokens:", "    SIGSTORE_ID_TOKEN:", "      aud: sigstore"] : []),
      "  script:",
      ...[
        'git checkout --detach "$CHANT_RELEASE_COMMIT"',
        ...cd,
        ...install,
        ...o.extra.gitlabScript,
        ...(o.goreleaser ?? []),
        ciFetch,
        ...auth,
        LEDGER_FETCH_FIRST,
        'git config user.name "chant release"',
        'git config user.email "chant-release@localhost"',
        `${o.chant} workspace train cut ${env} --at "$CHANT_RELEASE_COMMIT" --levels "\${CHANT_RELEASE_LEVELS:-auto}"${o.doctor ? " --doctor" : ""} --yes --json > /tmp/chant-train.json`,
        `train="$(${trainIdScript("/tmp/chant-train.json", "gitlab")})" || exit 1`,
        'printf \'CHANT_TRAIN_CUT=%s\\n\' "$train" > "$CI_PROJECT_DIR/chant-release-train.env"',
        ...(o.files ? [`if [ -n "$train" ]; then ${o.chant} workspace train artifacts ${env} "$train" -o "${GITLAB_TRAIN_STAGE}"; fi`] : []),
      ].map(q),
      "",
    );
  }
  const publishScript = (handed: boolean) => [
    // The cut's staged files leave the checkout before it moves to the train's commit.
    ...(handed && o.files ? [`if [ -d "${GITLAB_TRAIN_STAGE}" ]; then mv "${GITLAB_TRAIN_STAGE}" ${GITLAB_TRAIN_FROM}; fi`] : []),
    ...trainLines,
    ...cd,
    ...install,
    ...o.extra.gitlabScript,
    ...(o.goreleaser ?? []),
    ciFetch,
    ledgerFetch,
    ...(dispatch ? auth : []),
    `${o.chant} workspace train prepare ${env} "$CHANT_RELEASE_TRAIN"`,
    ...(o.build ? [o.build] : []),
    ...(o.files ? [`${o.chant} workspace train artifacts ${env} "$CHANT_RELEASE_TRAIN"${handed ? ` --from ${GITLAB_TRAIN_FROM}` : ""}`] : []),
    ...(o.verify ? [`${o.chant} workspace train verify ${env} "$CHANT_RELEASE_TRAIN"`] : []),
    'git config user.name "chant release"',
    'git config user.email "chant-release@localhost"',
    `${o.chant} workspace train publish ${env} "$CHANT_RELEASE_TRAIN" ${o.flags}`,
  ];
  const publishRules = dispatch ? [`    - if: $CHANT_RELEASE_TRAIN && ${manual}`, `    - if: ${cutRule}`] : [`    - if: ${tagRule}`];
  const publishNeeds = dispatch ? ["  needs:", "    - job: chant-release-cut", "      optional: true"] : [];
  lines.push(
    "chant-release-publish:",
    "  rules:",
    ...publishRules,
    ...variables(o.extra.gitlabVariables),
    ...publishNeeds,
    "  resource_group: chant-release",
    "  id_tokens:",
    "    SIGSTORE_ID_TOKEN:",
    "      aud: sigstore",
    ...(o.idTokens ?? []),
    "  script:",
    ...publishScript(dispatch).map(q),
  );
  if (o.after.length > 0) {
    lines.push(
      "",
      "chant-release-after:",
      "  rules:",
      ...publishRules,
      ...variables([]),
      ...(dispatch ? ["  needs:", "    - job: chant-release-cut", "      optional: true", "    - job: chant-release-publish"] : ["  needs: [chant-release-publish]"]),
      "  script:",
      ...[...trainLines, ...cd, ...install].map(q),
      ...o.after.map((l) => `    - ${l}`),
    );
  }
  return `${lines.join("\n")}\n`;
}
