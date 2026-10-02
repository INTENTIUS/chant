/**
 * "Alerting builds to provisioning files Grafana loads as they are", against
 * Grafana itself.
 *
 * Two builds are mounted into a pinned `grafana/grafana` container
 * (`CHANT_GRAFANA_ALERTING_IMAGE`, default 13.2.2) and read back through
 * the provisioning API (`/api/v1/provisioning/alert-rules`, `contact-points`,
 * `policies`, `mute-timings`, `templates`):
 *
 * 1. the alerting example: an `Slo`'s burn-rate rules (`SloAlertRules`),
 *    hand-written rules with typed expressions, contact points, a policy
 *    tree, a mute timing and a template;
 * 2. Grafana's own exports in `test/fixtures/alerting/grafana-13.2.2/`,
 *    imported with `chant import` and built back, provisioned beside the
 *    example's datasources (the exports query uids `prom` and `loki`).
 *
 * Every rule, contact point, timing and template must come back with the
 * uid, refIds, datasources, labels and routes chant wrote.
 *
 * Skipped, with the reason in the test name, when Docker is not running.
 * Run it through the Docker slot lock:
 * `.docker-slot.sh <label> -- npx vitest run lexicons/grafana/src/alerting.e2e.test.ts`.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus/serializer";
import { grafanaSerializer } from "./serializer";
import { ALERTING_FILE, type AlertingFile } from "./alerting-build";
import { DATASOURCES_FILE } from "./build";
import { GrafanaParser } from "./import/parser";
import { GrafanaGenerator } from "./import/generator";
import { fixturesDir, projectDir, read, removeDir, writeFiles } from "./import/testdata/fixtures";

const IMAGE = process.env.CHANT_GRAFANA_ALERTING_IMAGE ?? "grafana/grafana:13.2.2";

function available(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = available("docker info");
const skipReason = hasDocker ? "" : " (skipped: Docker is not running)";
const AUTH = `Basic ${Buffer.from("admin:admin").toString("base64")}`;
const example = join(dirname(dirname(fileURLToPath(import.meta.url))), "examples", "alerting", "src");

type Json = Record<string, unknown>;

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

const containers: string[] = [];
const dirs: string[] = [];

afterAll(() => {
  for (const c of containers) {
    try {
      execSync(`docker rm -f ${c}`, { stdio: "ignore" });
    } catch {
      // already gone
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Start Grafana with `files` mounted as its provisioning directory; resolves to an API client once every rule is loaded. */
async function grafanaWith(files: Record<string, string>, label: string, expectedRules: number) {
  const dir = mkdtempSync(join(tmpdir(), "chant-grafana-alerting-"));
  dirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  const name = `chant-grafana-alerting-${label}-${process.pid}`;
  containers.push(name);
  execSync(
    [
      "docker run -d",
      `--name ${name}`,
      "-p 127.0.0.1::3000",
      "-e GF_SECURITY_ADMIN_PASSWORD=admin",
      "-e GF_ANALYTICS_REPORTING_ENABLED=false",
      "-e GF_ANALYTICS_CHECK_FOR_UPDATES=false",
      // The secrets the example's contact points read with $__env{...}.
      "-e SLACK_ONCALL_WEBHOOK=https://hooks.slack.com/services/T0/B0/X",
      "-e TICKETS_TOKEN=token",
      "-e ONCALL_SLACK_URL=https://hooks.slack.com/services/T0/B0/Y",
      `-v ${join(dir, "provisioning")}:/etc/grafana/provisioning:ro`,
      IMAGE,
    ].join(" "),
    { stdio: "ignore" },
  );
  const port = execSync(`docker port ${name} 3000/tcp`).toString().trim().split("\n")[0].split(":").pop();
  const base = `http://127.0.0.1:${port}`;
  const api = async <T = Json>(path: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: AUTH } });
    return { status: res.status, body: (await res.json()) as T };
  };
  await waitFor("Grafana to answer", async () => ((await fetch(`${base}/api/health`)).ok ? true : undefined));
  const rules = await waitFor(`${expectedRules} provisioned alert rules`, async () => {
    const r = await api<Json[]>("/api/v1/provisioning/alert-rules");
    return r.status === 200 && r.body.length >= expectedRules ? r.body : undefined;
  }).catch((err) => {
    throw new Error(`${String(err)}\n${execSync(`docker logs ${name} 2>&1 | grep -i -E "alert|provision" | grep -i -E "error|fail" | tail -20`).toString()}`);
  });
  return { api, rules, name };
}

/** What a rule must keep through provisioning. */
function ruleShape(r: Json) {
  const data = (r.data as Json[]).map((q) => [q.refId, q.datasourceUid, (q.model as Json).type ?? (q.model as Json).expr ?? null]);
  return { uid: r.uid, title: r.title, condition: r.condition || undefined, data, labels: r.labels ?? {}, record: r.record ?? undefined };
}

function builtRules(file: AlertingFile): Array<ReturnType<typeof ruleShape>> {
  return (file.groups ?? []).flatMap((g) => g.rules.map((r) => ruleShape(r as unknown as Json)));
}

function byUid<T extends { uid?: unknown }>(list: T[]): T[] {
  return [...list].sort((a, b) => String(a.uid).localeCompare(String(b.uid)));
}

describe.skipIf(!hasDocker)(`Grafana provisions chant's alerting files${skipReason}`, () => {
  it(`the alerting example, into ${IMAGE}`, { timeout: 300_000 }, async () => {
    const result = await build(example, [prometheusSerializer, grafanaSerializer]);
    expect(result.errors).toEqual([]);
    const files = (result.outputs.get("grafana") as SerializerResult).files ?? {};
    const built = load(files[ALERTING_FILE]) as AlertingFile;
    const expected = builtRules(built);
    const { api, rules } = await grafanaWith(files, "example", expected.length);

    expect(byUid(rules.map(ruleShape))).toEqual(byUid(expected));
    for (const r of rules) expect(r.provenance).toBe("file");
    // Folders are created from their titles.
    const folders = (await api<Json[]>("/api/folders")).body.map((f) => f.title);
    for (const g of built.groups!) expect(folders).toContain(g.folder);

    const contactPoints = (await api<Json[]>("/api/v1/provisioning/contact-points")).body;
    const builtReceivers = built.contactPoints!.flatMap((c) => c.receivers.map((r) => [c.name, r.uid, r.type]));
    expect(contactPoints.map((c) => [c.name, c.uid, c.type]).sort()).toEqual(builtReceivers.sort());
    // A $__env{...} secret was read from the environment: Grafana holds it, and redacts it on the way out.
    expect((contactPoints.find((c) => c.type === "slack")!.settings as Json).url).toBe("[REDACTED]");

    const policy = (await api<Json>("/api/v1/provisioning/policies")).body;
    const builtPolicy = built.policies![0] as Json;
    expect(policy.receiver).toBe(builtPolicy.receiver);
    expect(policy.group_by).toEqual(builtPolicy.group_by);
    expect((policy.routes as Json[]).map((r) => [r.receiver, r.object_matchers, r.mute_time_intervals ?? []])).toEqual(
      (builtPolicy.routes as Json[]).map((r) => [r.receiver, r.object_matchers, r.mute_time_intervals ?? []]),
    );

    const timings = (await api<Json[]>("/api/v1/provisioning/mute-timings")).body;
    expect(timings.map((t) => [t.name, t.time_intervals])).toEqual(built.muteTimes!.map((t) => [t.name, t.time_intervals]));
    const templates = (await api<Json[]>("/api/v1/provisioning/templates")).body;
    expect(templates.map((t) => [t.name, t.template])).toEqual(built.templates!.map((t) => [t.name, t.template]));
  });

  it(`Grafana's own exports, imported and built back, into ${IMAGE}`, { timeout: 300_000 }, async () => {
    const dir = projectDir();
    let files: Record<string, string>;
    try {
      // Each export imported into the same project, as `chant import` would one after another.
      for (const f of readdirSync(join(fixturesDir, "alerting", "grafana-13.2.2")).sort()) {
        const ir = new GrafanaParser().parse(read("alerting", "grafana-13.2.2", f));
        const generated = new GrafanaGenerator().generate(ir).map((g) => ({ ...g, path: `${f.replace(/\.yaml$/, "")}/${g.path}` }));
        writeFiles(join(dir, "src"), generated);
      }
      const result = await build(join(dir, "src"), [grafanaSerializer]);
      expect(result.errors).toEqual([]);
      files = { ...((result.outputs.get("grafana") as SerializerResult).files ?? {}) };
    } finally {
      removeDir(dir);
    }
    // The exports' datasources (uids prom and loki) are the example's.
    const exampleBuild = await build(example, [prometheusSerializer, grafanaSerializer]);
    files[DATASOURCES_FILE] = ((exampleBuild.outputs.get("grafana") as SerializerResult).files ?? {})[DATASOURCES_FILE];
    const built = load(files[ALERTING_FILE]) as AlertingFile;
    const expected = builtRules(built);
    const { api, rules } = await grafanaWith(files, "exports", expected.length);

    expect(byUid(rules.map(ruleShape))).toEqual(byUid(expected));
    const source = load(read("alerting", "grafana-13.2.2", "alert-rules.yaml")) as AlertingFile;
    expect(rules.map((r) => r.uid).sort()).toEqual(source.groups!.flatMap((g) => g.rules.map((r) => r.uid)).sort());
    const contactPoints = (await api<Json[]>("/api/v1/provisioning/contact-points")).body;
    expect(contactPoints.map((c) => c.uid).sort()).toEqual(["chant-fx-oncall-email", "chant-fx-oncall-slack", "chant-fx-tickets"]);
    const policy = (await api<Json>("/api/v1/provisioning/policies")).body;
    expect(policy.receiver).toBe("oncall");
    expect((policy.routes as unknown[]).length).toBe(2);
  });
});
