/**
 * The harness's compose project (chant#4587): the services harnessStack
 * gives, the one pin file they read, the runner's config, and ./project/
 * built with `chant build` on the docker lexicon. Nothing here starts a
 * container.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { load } from "js-yaml";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCommandInProcess } from "../cli/main";
import { harnessProjectDir } from "./index";
import { pickJobContainer } from "./jobs";
import { CLICKHOUSE_IMAGE, FLOCI_CHANGE_SET_IMAGE, FLOCI_DIGEST, FLOCI_IMAGE, FORGEJO_IMAGE, FORGEJO_RUNNER_IMAGE, POSTGRES_IMAGE } from "./pins";
import { forgejoRunnerConfig, harnessStack, harnessUrls } from "./stack";

const repo = resolve(import.meta.dirname, "..", "..", "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "chant-e2e-stack-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("the harness's pins", () => {
  test("floci is held at 5ec92ae8, the build choudoufu and plunge pin (lex00/floci#265 for the move)", () => {
    expect(FLOCI_DIGEST).toBe("sha256:5ec92ae8046445d62c0009590dd09f04560886e5a5ef31248cb3fcc09b2961ec");
    expect(FLOCI_IMAGE).toBe(`ghcr.io/lex00/floci@${FLOCI_DIGEST}`);
    expect(FLOCI_CHANGE_SET_IMAGE).toContain("sha256:63d8f1ed");
    expect(readFileSync(join(import.meta.dirname, "pins.ts"), "utf8")).toContain("lex00/floci#265");
  });

  test("Forgejo 16.0.5 and forgejo-runner 13.2.0", () => {
    expect(FORGEJO_IMAGE).toBe("codeberg.org/forgejo/forgejo:16.0.5");
    expect(FORGEJO_RUNNER_IMAGE).toBe("data.forgejo.org/forgejo/runner:13.2.0");
  });

  test("the sql servers are the ones the sql lexicon pins", () => {
    const pin = readFileSync(join(repo, "lexicons", "sql", "src", "spec", "pin.ts"), "utf8");
    const version = /CLICKHOUSE_VERSION = "([^"]+)"/.exec(pin)![1];
    const digest = /CLICKHOUSE_IMAGE_DIGEST = "([^"]+)"/.exec(pin)![1];
    expect(CLICKHOUSE_IMAGE).toBe(`clickhouse/clickhouse-server:${version}@${digest}`);
    const pg = readFileSync(join(repo, "lexicons", "sql", "src", "spec", "postgres-pin.ts"), "utf8");
    const [, pgVersion, pgDigest] = /major: 18, version: "([^"]+)", digest: "([^"]+)"/.exec(pg)!;
    expect(POSTGRES_IMAGE).toBe(`postgres:${pgVersion}@${pgDigest}`);
  });
});

describe("harnessStack", () => {
  const h = harnessStack({ project: "bench-a", envPrefix: "BENCH_A" });

  test("names the network, the containers and the volumes after the project", () => {
    expect(h.network).toEqual({ name: "bench-a" });
    expect(Object.values(h.services).map((s) => s.container_name)).toEqual(["bench-a-floci", "bench-a-forgejo", "bench-a-forgejo-runner", "bench-a-clickhouse", "bench-a-postgres"]);
    expect(h.volumes).toEqual({ forgejoData: { name: "bench-a-forgejo-data" }, runnerData: { name: "bench-a-runner-data" } });
    for (const s of Object.values(h.services)) expect(Object.keys(s.networks)).toEqual(["harness"]);
    expect(() => harnessStack({ project: "Bench A" })).toThrow(/not a compose project name/);
  });

  test("binds host ports to 127.0.0.1, moved by the prefix's variables", () => {
    expect(h.services.floci.ports).toEqual(["127.0.0.1:${BENCH_A_FLOCI_PORT:-4591}:4566"]);
    expect(h.services.forgejo.ports).toEqual(["127.0.0.1:${BENCH_A_FORGEJO_PORT:-3391}:3000"]);
    expect(h.services.forgejoRunner.ports).toBeUndefined();
    expect(harnessUrls(h, { BENCH_A_FORGEJO_PORT: "4000" }).forgejo).toBe("http://localhost:4000");
    expect(harnessStack({ project: "demo", bind: null }).services.floci.ports).toEqual(["${CHANT_E2E_FLOCI_PORT:-4591}:4566"]);
  });

  test("runs forgejo-runner with the docker executor after Forgejo is healthy, and Actions on", () => {
    const r = h.services.forgejoRunner;
    expect(r.image).toBe(FORGEJO_RUNNER_IMAGE);
    expect(r.volumes).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(r.depends_on).toEqual({ forgejo: { condition: "service_healthy" } });
    expect(r.command!.at(-1)).toContain("forgejo-runner daemon -c /data/config.yml");
    expect(h.services.forgejo.environment!.FORGEJO__actions__ENABLED).toBe("true");
    expect(harnessStack({ project: "x", forgejoActions: false }).services.forgejo.environment!.FORGEJO__actions__ENABLED).toBe("false");
  });

  test("puts the sql emulator behind the sql profile, and nothing else", () => {
    expect(h.services.clickhouse.profiles).toEqual(["sql"]);
    expect(h.services.postgres.profiles).toEqual(["sql"]);
    for (const k of ["floci", "forgejo", "forgejoRunner"] as const) expect(h.services[k].profiles).toBeUndefined();
  });

  test("the runner's config puts every job on the project network, with floci for AWS", () => {
    const text = forgejoRunnerConfig({ network: "bench-a", uuid: "u-1", token: "t-1", jobImage: "node:22-bookworm" });
    const doc = load(text) as { container: { network: string; valid_volumes: string[] }; runner: { envs: Record<string, string>; labels: string[] }; server: { connections: { forgejo: { uuid: string; url: string } } } };
    expect(doc.container.network).toBe("bench-a");
    expect(doc.container.valid_volumes).toEqual([]);
    expect(doc.runner.envs.AWS_ENDPOINT_URL).toBe("http://floci:4566");
    expect(doc.runner.labels).toEqual(["docker:docker://node:22-bookworm", "ubuntu-latest:docker://node:22-bookworm"]);
    expect(doc.server.connections.forgejo).toMatchObject({ uuid: "u-1", url: "http://forgejo:3000/" });
  });

  test("kill-job picks the newest forgejo-runner job container that matches", () => {
    const ps = ["2026-10-28 10:02\tFORGEJO-ACTIONS-TASK-9_WORKFLOW-pr_JOB-pr-apply", "2026-10-28 10:01\tFORGEJO-ACTIONS-TASK-8_WORKFLOW-pr_JOB-pr-plan", "2026-10-28 09:00\tbench-a-floci"];
    expect(pickJobContainer(ps)).toBe("FORGEJO-ACTIONS-TASK-9_WORKFLOW-pr_JOB-pr-apply");
    expect(pickJobContainer(ps, "pr-plan")).toBe("FORGEJO-ACTIONS-TASK-8_WORKFLOW-pr_JOB-pr-plan");
    expect(pickJobContainer(ps, "drift")).toBeNull();
  });
});

interface ComposeDoc {
  services: Record<string, { image: string; ports?: string[]; profiles?: string[]; networks: Record<string, unknown>; container_name: string }>;
  networks: Record<string, { name: string }>;
}

describe("the harness's chant project", () => {
  let doc: ComposeDoc;

  beforeAll(async () => {
    const out = join(tmp, "compose.yaml");
    expect(await runCommandInProcess(["build", join(harnessProjectDir(), "src"), "--lexicon", "docker", "-o", out])).toBe(0);
    doc = load(readFileSync(out, "utf8")) as ComposeDoc;
  }, 60_000);

  test("builds floci, Forgejo and forgejo-runner on one network, the sql emulator behind its profile", () => {
    expect(Object.keys(doc.services).sort()).toEqual(["clickhouse", "floci", "forgejo", "forgejoRunner", "postgres"]);
    expect(doc.networks.harness!.name).toBe("chant-e2e");
    for (const s of Object.values(doc.services)) expect(Object.keys(s.networks)).toEqual(["harness"]);
    expect(doc.services.floci!.image).toBe(FLOCI_IMAGE);
    expect(doc.services.forgejo!.image).toBe(FORGEJO_IMAGE);
    expect(doc.services.forgejoRunner!.image).toBe(FORGEJO_RUNNER_IMAGE);
    expect(doc.services.clickhouse!.profiles).toEqual(["sql"]);
    expect(doc.services.postgres!.profiles).toEqual(["sql"]);
    expect(doc.services.floci!.ports).toEqual(["127.0.0.1:${CHANT_E2E_FLOCI_PORT:-4591}:4566"]);
  });
});
