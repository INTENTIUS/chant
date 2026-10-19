/**
 * The fan-out demo's stack (#4085 sections 2, 4 and 6), one compose project,
 * `chant-fan-out-demo`: Forgejo, the forgejo-runner that runs the example's
 * generated workflow, and floci, the AWS emulator the fifteen stacks apply to.
 *
 * Every service is on one network, `chant-fan-out-demo`, where jobs reach
 * floci as `floci:4566` (the example's `demo` environment) and Forgejo as
 * `forgejo:3000` (its ROOT_URL, the host chant names reviewers by). The
 * driver reaches them on localhost through the published ports.
 *
 * The runner's config is a compose config: its envs give every job floci's
 * endpoint and test credentials, which both cfn-deploy and the
 * `--report-url` upload read, so the workflow names no endpoint. The runner's
 * uuid and token come from Forgejo after it boots, so the driver registers
 * the runner and passes them to `docker compose up` in the environment.
 */
import { DockerConfig, Network, Service, Volume } from "@intentius/chant-lexicon-docker";

/** The compose project and the network every service and job is on. */
export const PROJECT = "chant-fan-out-demo";
/** The image every job runs in (job-image.ts), as the generated workflow names it. */
export const JOB_IMAGE = "chant-fan-out-demo-job:local";

/** One network with a fixed name, so the runner's job containers can join it. */
export const demo = new Network({ name: PROJECT });

/** A service on the network, by its key in the compose file, with the names jobs reach it by. */
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
    FORGEJO__actions__ENABLED: "true",
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

/** The runner's config. Compose fills the uuid and token from the driver's environment. */
export const runnerConfig = new DockerConfig({
  name: `${PROJECT}-runner-config`,
  content: [
    "log:",
    "  level: info",
    "runner:",
    "  file: /data/.runner",
    "  capacity: 2",
    "  timeout: 30m",
    "  fetch_interval: 1s",
    "  report_interval: 1s",
    "  envs:",
    "    AWS_ENDPOINT_URL: http://floci:4566",
    "    AWS_ACCESS_KEY_ID: test",
    "    AWS_SECRET_ACCESS_KEY: test",
    "    AWS_REGION: us-east-1",
    "  labels:",
    `    - "docker:docker://${JOB_IMAGE}"`,
    "cache:",
    "  enabled: false",
    "container:",
    `  network: ${PROJECT}`,
    "  privileged: false",
    '  docker_host: "-"',
    "  force_pull: false",
    "server:",
    "  connections:",
    "    forgejo:",
    "      url: http://forgejo:3000/",
    "      uuid: ${CHANT_FAN_OUT_DEMO_RUNNER_UUID:-}",
    "      token: ${CHANT_FAN_OUT_DEMO_RUNNER_TOKEN:-}",
    "",
  ].join("\n"),
});

export const runnerData = new Volume({ name: `${PROJECT}-runner-data` });

// The docker executor: one job container per job, from JOB_IMAGE, which the
// driver builds into the local daemon (force_pull: false finds it there).
// Root, so it can use the socket Docker Desktop mounts as root:root.
export const runner = new Service({
  image: "data.forgejo.org/forgejo/runner:13.2.0",
  container_name: `${PROJECT}-forgejo-runner`,
  user: "0:0",
  depends_on: { forgejo: { condition: "service_healthy" } },
  volumes: ["/var/run/docker.sock:/var/run/docker.sock", "runnerData:/data"],
  configs: [{ source: "runnerConfig", target: "/etc/forgejo-runner/config.yml" }],
  working_dir: "/data",
  command: ["forgejo-runner", "daemon", "-c", "/etc/forgejo-runner/config.yml"],
  networks: onDemo("forgejo-runner"),
  restart: "unless-stopped",
});
