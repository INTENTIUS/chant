/**
 * The observe-converge example's two ConvergeOps, run by the local executor
 * against a real Prometheus and a real collector in Docker (#3369).
 *
 * - `rules-loaded`: Prometheus starts with an empty rule file, so the SLO's
 *   group is drifted ("group not loaded"); the built rule file is put in its
 *   place and Prometheus reloaded, and the next tick is in-sync.
 * - `collector-health`: the collector runs the built config, and the tick
 *   is in-sync; with the collector stopped, the next tick is drifted.
 *
 * Each tick's verdicts are read from the converge ledger the tick wrote, in
 * a scratch git repository the run's working directory is moved to (the
 * ledger lives on its `chant/lifecycle` branch). The collector's ports are
 * published on the ones its config declares, 13133 and 8888, so the
 * observer reads them unchanged; the test skips when either is taken.
 * Prometheus gets a free port, passed as $PROMETHEUS_URL.
 *
 * On demand: skipped, with the reason in the name, unless Docker runs.
 */
import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { loadActivities, loadProfiles, runOpLocally } from "@intentius/chant/op";
import { readConvergeLedger } from "@intentius/chant/lifecycle/converge-ledger";
import { COLLECTOR_IMAGE, otelSerializer } from "@intentius/chant-lexicon-otel";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus";
import { rulesLoaded } from "./observe-converge/ops/rules-loaded.op";
import { collectorHealth } from "./observe-converge/ops/collector-health.op";

const PROMETHEUS_IMAGE = "prom/prometheus:v3.15.0";
const example = join(import.meta.dirname, "observe-converge");
const suffix = randomBytes(4).toString("hex");
const PROM = `chant-observe-prom-${suffix}`;
const OTEL = `chant-observe-otel-${suffix}`;

function dockerRuns(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === "object" ? resolve(addr.port) : reject(new Error("no port"))));
    });
  });
}

const skipReason = !dockerRuns()
  ? "Docker is not running"
  : !(await portFree(13133)) || !(await portFree(8888))
    ? "port 13133 or 8888 is taken"
    : undefined;

function text(out: string | SerializerResult | undefined): string {
  if (out === undefined) throw new Error("no output");
  return typeof out === "string" ? out : out.primary;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, ok: () => Promise<boolean>, ms = 90_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ok().catch(() => false)) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function rm(name: string): void {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    // already gone
  }
}

/** Run one ConvergeOp tick and return the resources its ledger record holds. */
async function tick(op: typeof rulesLoaded): Promise<Array<{ name: string; status: string; detail?: string }>> {
  const activities = await loadActivities(["prometheus", "otel"]);
  const result = await runOpLocally(op.props as never, activities, await loadProfiles());
  expect(result.status, JSON.stringify(result.records.map((r) => [r.fn, r.status, r.error]))).toBe("ok");
  const { records } = await readConvergeLedger("local");
  const last = records[records.length - 1] as unknown as { op: string; resources?: Array<{ name: string; status: string; detail?: string }> };
  expect(last.op).toBe((op.props as unknown as { name: string }).name);
  return last.resources ?? [];
}

describe.skipIf(skipReason !== undefined)(`observe-converge example on Docker${skipReason ? ` (skipped: ${skipReason})` : ""}`, () => {
  let work: string;
  let promPort: number;
  const cwd = process.cwd();
  const env = process.env.PROMETHEUS_URL;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "chant-observe-converge-"));
    const dist = join(work, "dist");
    const promDir = join(work, "prometheus");
    mkdirSync(dist);
    mkdirSync(promDir);

    const rules = await build(join(example, "src"), [prometheusSerializer]);
    expect(rules.errors).toEqual([]);
    writeFileSync(join(dist, "rules.yml"), text(rules.outputs.get("prometheus")));
    const collector = await build(join(example, "collector"), [otelSerializer]);
    expect(collector.errors).toEqual([]);
    writeFileSync(join(dist, "collector.yaml"), text(collector.outputs.get("otel")));

    // Prometheus starts with no groups loaded; the test swaps the built file in later.
    writeFileSync(join(promDir, "rules.yml"), "groups: []\n");
    writeFileSync(join(promDir, "prometheus.yml"), "global:\n  evaluation_interval: 5s\nrule_files:\n  - /etc/prometheus/rules.yml\n");

    // The ledger is a git branch of the working directory.
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "e2e@chant.local"], ["config", "user.name", "e2e"], ["commit", "-q", "--allow-empty", "-m", "init"]]) {
      execFileSync("git", args, { cwd: work });
    }

    promPort = await freePort();
    execFileSync("docker", [
      "run", "-d", "--name", PROM, "-p", `127.0.0.1:${promPort}:9090`,
      "-v", `${promDir}:/etc/prometheus:ro`,
      PROMETHEUS_IMAGE, "--config.file=/etc/prometheus/prometheus.yml", "--web.enable-lifecycle",
    ]);
    execFileSync("docker", [
      "run", "-d", "--name", OTEL, "-p", "13133:13133", "-p", "8888:8888",
      "-v", `${dist}:/etc/otelcol:ro`,
      COLLECTOR_IMAGE, "--config=/etc/otelcol/collector.yaml",
    ]);
    process.env.PROMETHEUS_URL = `http://127.0.0.1:${promPort}`;
    process.chdir(work);
    await waitFor("Prometheus", async () => (await fetch(`http://127.0.0.1:${promPort}/-/ready`)).ok);
    await waitFor("the collector's health_check", async () => (await fetch("http://127.0.0.1:13133/")).ok);
  }, 300_000);

  afterAll(() => {
    process.chdir(cwd);
    if (env === undefined) delete process.env.PROMETHEUS_URL;
    else process.env.PROMETHEUS_URL = env;
    rm(PROM);
    rm(OTEL);
  });

  test("rules-loaded: drifted while the group is not loaded, in-sync once it is", async () => {
    const before = await tick(rulesLoaded);
    expect(before).toEqual([{ name: "slo-checkout", status: "drifted", detail: "group not loaded" }]);

    copyFileSync(join(work, "dist", "rules.yml"), join(work, "prometheus", "rules.yml"));
    const reload = await fetch(`http://127.0.0.1:${promPort}/-/reload`, { method: "POST" });
    expect(reload.ok).toBe(true);
    await waitFor("the group to load", async () => {
      const body = (await (await fetch(`http://127.0.0.1:${promPort}/api/v1/rules`)).json()) as { data: { groups: Array<{ name: string }> } };
      return body.data.groups.some((g) => g.name === "slo-checkout");
    });

    const after = await tick(rulesLoaded);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ name: "slo-checkout", status: "in-sync" });
  }, 180_000);

  test("collector-health: in-sync while the collector answers, drifted once it stops", async () => {
    const up = await tick(collectorHealth);
    expect(up).toEqual([{ name: "collector", status: "in-sync", detail: "health_check ok, telemetry ok" }]);

    execFileSync("docker", ["stop", OTEL], { stdio: "ignore" });
    const down = await tick(collectorHealth);
    expect(down).toHaveLength(1);
    expect(down[0].status).toBe("drifted");
    expect(down[0].detail).toMatch(/health_check http:\/\/localhost:13133\/ did not answer/);
  }, 180_000);
});
