/**
 * The e2e harness's compose project (chant#4587), as data a chant
 * docker-lexicon project wraps: floci, Forgejo and forgejo-runner with the
 * docker executor on one network, and the sql emulator's ClickHouse and
 * Postgres behind the `sql` profile. Every image comes from ./pins.ts.
 *
 * Core does not depend on the docker lexicon, so this file returns plain
 * service properties. A product's project hands each to the lexicon's
 * `Service`, under the key named here (compose keys are export names):
 *
 * ```ts
 * import { Network, Service, Volume } from "@intentius/chant-lexicon-docker";
 * import { harnessStack } from "@intentius/chant/e2e-harness";
 * const h = harnessStack({ project: "terragucci-e2e", envPrefix: "TERRAGUCCI_E2E" });
 * export const harness = new Network(h.network);
 * export const floci = new Service(h.services.floci);
 * ...
 * ```
 *
 * ./project/ is that project for the whole stack, and the fan-out demo's
 * stack/src/compose.ts takes floci and Forgejo from it.
 *
 * Two rules from terragucci's stack hold here. A forge's public URL is its
 * service name (http://forgejo:3000), since inside a job container localhost
 * is the job container. The network has a fixed name, the project's, and the
 * runner puts every job container on it. Host ports bind to 127.0.0.1 and
 * move with `<envPrefix>_<SERVICE>_PORT`, and every name carries the project,
 * so two benches share a host (plywood stack/compose.yml does the same).
 */
import { CLICKHOUSE_IMAGE, FLOCI_IMAGE, FORGEJO_IMAGE, FORGEJO_RUNNER_IMAGE, POSTGRES_IMAGE, POSTGRES_PASSWORD } from "./pins";

/**
 * The service properties the harness sets, a subset of compose's. A type
 * alias, not an interface: the docker lexicon's ServiceProps has an `x-` index
 * signature, which only an alias's implicit index signature satisfies.
 */
export type ComposeServiceSpec = {
  image: string;
  container_name: string;
  profiles?: string[];
  user?: string;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  working_dir?: string;
  command?: string[];
  depends_on?: Record<string, { condition: "service_started" | "service_healthy" }>;
  networks: Record<string, { aliases: string[] }>;
  healthcheck?: { test: string[]; interval: string; timeout: string; retries: number };
  restart?: string;
};

export interface HarnessStackOptions {
  /**
   * The compose project, which also names the network, the containers and
   * the volumes. Pass it to `docker compose -p` as well.
   */
  project: string;
  /** The prefix of the port variables, `<envPrefix>_FLOCI_PORT` and so on. Default `CHANT_E2E`. */
  envPrefix?: string;
  /** The network's export name in the product's project. Default `harness`. */
  networkKey?: string;
  /** Default host ports. */
  ports?: Partial<HarnessPorts>;
  /**
   * The address host ports bind to. Default 127.0.0.1. Null publishes on
   * every interface, for a demo host whose viewers read floci from outside.
   */
  bind?: string | null;
  /** Forgejo Actions on the instance. Default true; off when nothing on the forge runs workflows. */
  forgejoActions?: boolean;
  /** Another floci image, for a bench that needs the other line (pins.ts). Rows still name the one they ran on. */
  flociImage?: string;
}

export interface HarnessPorts {
  floci: number;
  forgejo: number;
  clickhouse: number;
  postgres: number;
}

/** The default host ports, off every tool's own default and off terragucci's and plywood's benches. */
export const HARNESS_PORTS: HarnessPorts = { floci: 4591, forgejo: 3391, clickhouse: 8124, postgres: 5433 };

/** The profile the sql emulator's servers are behind. */
export const SQL_PROFILE = "sql";

/** Inside the network: the addresses jobs and the runner use. */
export const HARNESS_HOSTS = {
  floci: "http://floci:4566",
  forgejo: "http://forgejo:3000",
  clickhouse: "http://clickhouse:8123",
  postgres: "postgres://postgres:chant@postgres:5432/postgres",
} as const;

/** Where forgejo-runner reads its config, which `forgejoRunnerConfig` writes. */
export const RUNNER_CONFIG_PATH = "/data/config.yml";

export interface HarnessStack {
  project: string;
  /** The network's properties, under `networkKey`. */
  network: { name: string };
  networkKey: string;
  /** Volumes by export name. */
  volumes: { forgejoData: { name: string }; runnerData: { name: string } };
  /** Services by export name, which is their compose key. */
  services: {
    floci: ComposeServiceSpec;
    forgejo: ComposeServiceSpec;
    forgejoRunner: ComposeServiceSpec;
    clickhouse: ComposeServiceSpec;
    postgres: ComposeServiceSpec;
  };
  /** The port variables, by service. */
  portVars: Record<keyof HarnessPorts, string>;
}

/** A project name compose and the harness accept: lower case, digits, `-` and `_`, starting with a letter or digit. */
export function assertProjectName(project: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error(`"${project}" is not a compose project name (lower case, digits, - and _)`);
}

export function harnessStack(o: HarnessStackOptions): HarnessStack {
  assertProjectName(o.project);
  const p = o.project;
  const prefix = o.envPrefix ?? "CHANT_E2E";
  const key = o.networkKey ?? "harness";
  const ports = { ...HARNESS_PORTS, ...o.ports };
  const bind = o.bind === undefined ? "127.0.0.1" : o.bind;
  const portVars: Record<keyof HarnessPorts, string> = {
    floci: `${prefix}_FLOCI_PORT`,
    forgejo: `${prefix}_FORGEJO_PORT`,
    clickhouse: `${prefix}_CLICKHOUSE_PORT`,
    postgres: `${prefix}_POSTGRES_PORT`,
  };
  const publish = (svc: keyof HarnessPorts, inner: number): string =>
    `${bind ? `${bind}:` : ""}\${${portVars[svc]}:-${ports[svc]}}:${inner}`;
  const on = (...aliases: string[]) => ({ [key]: { aliases } });

  return {
    project: p,
    network: { name: p },
    networkKey: key,
    volumes: { forgejoData: { name: `${p}-forgejo-data` }, runnerData: { name: `${p}-runner-data` } },
    portVars,
    services: {
      floci: {
        image: o.flociImage ?? FLOCI_IMAGE,
        container_name: `${p}-floci`,
        ports: [publish("floci", 4566)],
        networks: on("floci", "000000000000.floci"),
        restart: "unless-stopped",
      },
      // sqlite and INSTALL_LOCK skip the web installer; the driver makes the
      // admin and the people with Forgejo's own CLI.
      forgejo: {
        image: FORGEJO_IMAGE,
        container_name: `${p}-forgejo`,
        environment: {
          FORGEJO__database__DB_TYPE: "sqlite3",
          FORGEJO__security__INSTALL_LOCK: "true",
          FORGEJO__server__DOMAIN: "forgejo",
          FORGEJO__server__ROOT_URL: "http://forgejo:3000/",
          FORGEJO__server__HTTP_PORT: "3000",
          FORGEJO__server__DISABLE_SSH: "true",
          FORGEJO__service__DISABLE_REGISTRATION: "true",
          FORGEJO__actions__ENABLED: o.forgejoActions === false ? "false" : "true",
          FORGEJO__repository__DEFAULT_BRANCH: "main",
          FORGEJO__log__LEVEL: "warn",
        },
        ports: [publish("forgejo", 3000)],
        volumes: ["forgejoData:/data"],
        networks: on("forgejo"),
        healthcheck: {
          test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/api/v1/version"],
          interval: "3s",
          timeout: "3s",
          retries: 40,
        },
        restart: "unless-stopped",
      },
      // The docker executor: one job container per job through the host's
      // socket, on the project network (container.network in the config
      // registerForgejoRunner writes). It waits for that config, since the
      // runner's credentials come from Forgejo after it boots. Root, for the
      // socket Docker Desktop mounts as root:root.
      forgejoRunner: {
        image: FORGEJO_RUNNER_IMAGE,
        container_name: `${p}-forgejo-runner`,
        user: "0:0",
        depends_on: { forgejo: { condition: "service_healthy" } },
        volumes: ["/var/run/docker.sock:/var/run/docker.sock", "runnerData:/data"],
        working_dir: "/data",
        command: [
          "sh",
          "-c",
          `while [ ! -s ${RUNNER_CONFIG_PATH} ]; do sleep 1; done; exec forgejo-runner daemon -c ${RUNNER_CONFIG_PATH}`,
        ],
        networks: on("forgejo-runner"),
        restart: "unless-stopped",
      },
      clickhouse: {
        image: CLICKHOUSE_IMAGE,
        container_name: `${p}-clickhouse`,
        profiles: [SQL_PROFILE],
        environment: { CLICKHOUSE_SKIP_USER_SETUP: "1" },
        ports: [publish("clickhouse", 8123)],
        networks: on("clickhouse"),
        healthcheck: { test: ["CMD", "wget", "--spider", "-q", "http://localhost:8123/ping"], interval: "2s", timeout: "3s", retries: 60 },
        restart: "unless-stopped",
      },
      postgres: {
        image: POSTGRES_IMAGE,
        container_name: `${p}-postgres`,
        profiles: [SQL_PROFILE],
        environment: { POSTGRES_PASSWORD },
        ports: [publish("postgres", 5432)],
        networks: on("postgres"),
        healthcheck: { test: ["CMD", "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], interval: "2s", timeout: "3s", retries: 60 },
        restart: "unless-stopped",
      },
    },
  };
}

/** The host URLs of a stack's services, from its port variables in `env` or the defaults. */
export function harnessUrls(
  s: Pick<HarnessStack, "portVars">,
  env: Record<string, string | undefined> = process.env,
  defaults: HarnessPorts = HARNESS_PORTS,
): Record<keyof HarnessPorts, string> {
  const port = (k: keyof HarnessPorts) => Number(env[s.portVars[k]] ?? defaults[k]);
  return {
    floci: `http://localhost:${port("floci")}`,
    forgejo: `http://localhost:${port("forgejo")}`,
    clickhouse: `http://localhost:${port("clickhouse")}`,
    postgres: `postgres://postgres:${POSTGRES_PASSWORD}@localhost:${port("postgres")}/postgres`,
  };
}

export interface RunnerConfigOptions {
  /** The project network every job container joins. */
  network: string;
  /** The runner's uuid and token, from POST /admin/actions/runners. */
  uuid: string;
  token: string;
  /** The image the `docker` and `ubuntu-latest` labels run. */
  jobImage: string;
  /** Jobs at once. Default 4. */
  capacity?: number;
  /** Environment every job gets. Default floci's endpoint and test credentials. */
  envs?: Record<string, string>;
}

/** What every job gets by default: AWS is floci, as a CI runner in a real account carries that account's credentials. */
export const RUNNER_JOB_ENV: Record<string, string> = {
  AWS_ENDPOINT_URL: HARNESS_HOSTS.floci,
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
  AWS_REGION: "us-east-1",
  AWS_EC2_METADATA_DISABLED: "true",
};

const q = (s: string): string => JSON.stringify(s);

/**
 * forgejo-runner's config (Forgejo 16, runner 13): the server connection by
 * uuid and token, the job containers on the project network, no host
 * mounts, and floci for AWS.
 */
export function forgejoRunnerConfig(o: RunnerConfigOptions): string {
  const envs = o.envs ?? RUNNER_JOB_ENV;
  return [
    "log:",
    "  level: info",
    "  job_level: info",
    "runner:",
    "  file: /data/.runner",
    `  capacity: ${o.capacity ?? 4}`,
    "  timeout: 30m",
    "  shutdown_timeout: 0s",
    "  fetch_interval: 1s",
    "  report_interval: 1s",
    "  envs:",
    ...Object.entries(envs).map(([k, v]) => `    ${k}: ${q(v)}`),
    "  labels:",
    `    - ${q(`docker:docker://${o.jobImage}`)}`,
    `    - ${q(`ubuntu-latest:docker://${o.jobImage}`)}`,
    "cache:",
    "  enabled: false",
    "container:",
    `  network: ${q(o.network)}`,
    "  privileged: false",
    "  valid_volumes: []",
    '  docker_host: "-"',
    "  force_pull: false",
    "server:",
    "  connections:",
    "    forgejo:",
    "      url: http://forgejo:3000/",
    `      uuid: ${q(o.uuid)}`,
    `      token: ${q(o.token)}`,
    "",
  ].join("\n");
}
