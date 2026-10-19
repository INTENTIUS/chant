/**
 * The fan-out demo's stack (#4085 sections 2, 4 and 6, #4100), one compose
 * project, `chant-fan-out-demo`: Forgejo, chant's own runner (`chant ci
 * serve`) and floci, the AWS emulator the fifteen stacks apply to.
 *
 * Every service is on one network, `chant-fan-out-demo`, where the runner
 * reaches floci as `floci:4566` (the example's `demo` environment) and
 * Forgejo as `forgejo:3000` (its ROOT_URL, the host chant names reviewers
 * by). The driver reaches them on localhost through the published ports.
 *
 * The runner runs each job in process, in a fresh git worktree of its own
 * clone, so it needs no Docker socket. Its secrets file gives every job
 * floci's endpoint and test credentials, which both cfn-deploy and the
 * `--report-url` upload read. `up` writes that file and mints the runner's
 * forge token, and passes both to `docker compose` in the environment.
 * Forgejo Actions is off: the demo repo has no workflow file.
 */
import { Network, Service, Volume } from "@intentius/chant-lexicon-docker";

/** The compose project and the network every service and job is on. */
export const PROJECT = "chant-fan-out-demo";
/** The image the runner runs in (job-image.ts), with chant, the aws lexicon, git and the AWS CLI. */
export const JOB_IMAGE = "chant-fan-out-demo-job:local";

/** One network with a fixed name, which the driver's base apply joins too. */
export const demo = new Network({ name: PROJECT });

/** A service on the network, by its key in the compose file, with the names others reach it by. */
const onDemo = (...aliases: string[]) => ({ demo: { aliases } });

// floci from the lex00/floci fork, pinned by the index digest of
// ghcr.io/lex00/floci:b491869 (branch fix/cfn-change-set-changes), which
// describes a change set's changes for chant's plan counts and keeps SNS
// tags. The index carries linux/amd64 and linux/arm64.
export const floci = new Service({
  image: "ghcr.io/lex00/floci@sha256:63d8f1ed5ef595d7356c6f76318f3d76bc31ce3250cdf2dd8d14bd4d59604b8d",
  container_name: `${PROJECT}-floci`,
  ports: ["${CHANT_FAN_OUT_DEMO_FLOCI_PORT:-4590}:4566"],
  networks: onDemo("floci", "000000000000.floci"),
  restart: "unless-stopped",
});

export const forgejoData = new Volume({ name: `${PROJECT}-forgejo-data` });

// sqlite and INSTALL_LOCK skip the web installer; the driver creates the
// admin, the author and the reviewer with Forgejo's own CLI.
export const forgejo = new Service({
  image: "codeberg.org/forgejo/forgejo:16.0.5",
  container_name: `${PROJECT}-forgejo`,
  environment: {
    FORGEJO__database__DB_TYPE: "sqlite3",
    FORGEJO__security__INSTALL_LOCK: "true",
    FORGEJO__server__DOMAIN: "forgejo",
    FORGEJO__server__ROOT_URL: "http://forgejo:3000/",
    FORGEJO__server__HTTP_PORT: "3000",
    FORGEJO__server__DISABLE_SSH: "true",
    FORGEJO__service__DISABLE_REGISTRATION: "true",
    FORGEJO__actions__ENABLED: "false",
    FORGEJO__repository__DEFAULT_BRANCH: "main",
    FORGEJO__log__LEVEL: "warn",
  },
  ports: ["${CHANT_FAN_OUT_DEMO_FORGEJO_PORT:-3390}:3000"],
  volumes: ["forgejoData:/data"],
  networks: onDemo("forgejo"),
  healthcheck: {
    test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/api/v1/version"],
    interval: "3s",
    timeout: "3s",
    retries: 40,
  },
  restart: "unless-stopped",
});


/** The demo repo, as the runner serves it. */
export const RUNNER_REPO = "chant-demo/fan-out-estate";
/** The runner's state directory: its key, its clone, its job state and its resume records. */
export const RUNNER_STATE = "/var/lib/chant-runner";
/** The secrets file `ci serve` reads, mode 0600, copied from the one `up` writes. */
export const RUNNER_SECRETS = "/run/chant/secrets.env";
/** Where the file `up` writes is mounted, read-only. */
export const RUNNER_SECRETS_MOUNT = "/etc/chant-fan-out-demo/runner-secrets.env";
/** The Forgejo user the runner reads the forge, comments and pushes chant/lifecycle as. */
export const RUNNER_LOGIN = "chant-runner";

/**
 * The serve, one pass at a time (`--once`), every two seconds. The flags are
 * the generated workflow's (`--env demo --events-json --report-url ...
 * --pr-build-command`), so the jobs write their reports under the same
 * `<pr>/<commit>/` keys. `--image` names the job image, so the runner adds
 * no setup line of its own: the image has everything a job runs.
 */
export const RUNNER_SERVE = [
  "chant", "ci", "serve",
  "--forge", "forgejo",
  "--repo", RUNNER_REPO,
  "--env", "demo",
  "--branch", "main",
  "--author", "author",
  "--events-json",
  "--report-url", "s3://chant-demo/fan-out-estate/reports",
  "--pr-build-command", "'npm run build'",
  "--image", JOB_IMAGE,
  "--secrets", RUNNER_SECRETS,
  "--state", RUNNER_STATE,
  "--once",
].join(" ");

/**
 * The runner's script. Compose interpolates `${...}`, so the shell's own
 * variables are spelled `$$`. It copies the secrets file to a 0600 file this
 * user owns (ci serve refuses any other), clones the demo repo into the
 * state volume once, and points its remote at the current token. Between
 * passes, when the demo repo has no chant/lifecycle (a reset deletes it),
 * it drops the clone's own copy, so the next cycle's ledger starts from the
 * forge's and never forks from the last one.
 */
export const RUNNER_SCRIPT = [
  "set -e",
  "install -d -m 700 /run/chant",
  `install -m 600 ${RUNNER_SECRETS_MOUNT} ${RUNNER_SECRETS}`,
  `cd ${RUNNER_STATE}`,
  `remote="http://${RUNNER_LOGIN}:$$GITHUB_TOKEN@forgejo:3000/${RUNNER_REPO}.git"`,
  '[ -d repo/.git ] || git clone -q "$$remote" repo',
  "cd repo",
  'git remote set-url origin "$$remote"',
  `git config user.name ${RUNNER_LOGIN}`,
  `git config user.email ${RUNNER_LOGIN}@chant-demo.local`,
  "while :; do",
  "  git fetch -q --prune origin || true",
  "  rc=0; git ls-remote --exit-code -q origin refs/heads/chant/lifecycle >/dev/null 2>&1 || rc=$$?",
  '  if [ "$$rc" = 2 ]; then git update-ref -d refs/heads/chant/lifecycle 2>/dev/null || true; fi',
  `  ${RUNNER_SERVE} || true`,
  "  sleep 2",
  "done",
].join("\n");

export const runnerState = new Volume({ name: `${PROJECT}-runner-state` });

// chant's runner in the job image, which up builds into the local daemon
// (pull_policy never finds it there). It runs as root, the image's user, and
// owns the state volume. Its forge token is the chant-runner user's, minted
// by up; the secrets file is up's too, so compose refuses to start the
// service without them.
export const chantRunner = new Service({
  image: JOB_IMAGE,
  pull_policy: "never",
  container_name: `${PROJECT}-chant-runner`,
  depends_on: { forgejo: { condition: "service_healthy" }, floci: { condition: "service_started" } },
  environment: {
    GITHUB_SERVER_URL: "http://forgejo:3000",
    GITHUB_API_URL: "http://forgejo:3000/api/v1",
    GITHUB_TOKEN: "${CHANT_FAN_OUT_DEMO_RUNNER_TOKEN:-}",
  },
  volumes: [
    `runnerState:${RUNNER_STATE}`,
    `\${CHANT_FAN_OUT_DEMO_RUNNER_SECRETS:?run npm run demo -- up}:${RUNNER_SECRETS_MOUNT}:ro`,
  ],
  working_dir: RUNNER_STATE,
  command: ["sh", "-c", RUNNER_SCRIPT],
  networks: onDemo("chant-runner"),
  restart: "unless-stopped",
});
