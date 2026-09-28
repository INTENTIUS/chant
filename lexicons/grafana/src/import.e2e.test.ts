/**
 * "A dashboard builds to JSON that Grafana imports without edits", against
 * Grafana itself.
 *
 * Builds each example (getting-started, and dashboards-from-declarations,
 * whose dashboards the RED, SLO and agent composites build), mounts its
 * provisioning files and dashboards into a pinned `grafana/grafana`
 * container, and asserts that
 * Grafana provisioned every datasource and dashboard and hands each
 * dashboard back with the panels that were built. It then imports the same
 * JSON a second time through `POST /api/dashboards/db`, the path the UI's
 * import uses, under another uid.
 *
 * Skipped, with the reason in the test name, when Docker is not running.
 * On demand: `npx vitest run --project e2e lexicons/grafana`.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import type { Serializer } from "@intentius/chant/serializer";
import { otelSerializer } from "@intentius/chant-lexicon-otel/serializer";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus/serializer";
import { grafanaSerializer } from "./serializer";

/** The Grafana release the import test runs against; `CHANT_GRAFANA_IMAGE` overrides it. */
export const GRAFANA_IMAGE = process.env.CHANT_GRAFANA_IMAGE ?? "grafana/grafana:12.4.11";

function available(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = available("docker info");
const skipReason = hasDocker ? "" : "Docker is not running";
const AUTH = `Basic ${Buffer.from("admin:admin").toString("base64")}`;
const examples = join(dirname(dirname(fileURLToPath(import.meta.url))), "examples");

/** Each example, and the serializers its build root needs. */
const EXAMPLES: Array<{ name: string; serializers: Serializer[] }> = [
  { name: "getting-started", serializers: [grafanaSerializer] },
  { name: "dashboards-from-declarations", serializers: [otelSerializer, prometheusSerializer, grafanaSerializer] },
];

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

describe.skipIf(!hasDocker).each(EXAMPLES)(`Grafana imports the $name dashboards without edits${skipReason ? ` (skipped: ${skipReason})` : ""}`, ({ name, serializers }) => {
  const CONTAINER = `chant-grafana-import-${name}-${process.pid}`;
  const dir = mkdtempSync(join(tmpdir(), "chant-grafana-import-"));

  afterAll(() => {
    try {
      execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("provisions every datasource and dashboard, and accepts the JSON through the import API", { timeout: 300_000 }, async () => {
    const result = await build(join(examples, name, "src"), serializers);
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("grafana") as SerializerResult;
    for (const [file, content] of Object.entries(out.files ?? {})) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    const index = JSON.parse(out.primary) as { dashboards: Array<{ uid: string; title: string; folder?: string; file: string }>; datasources: Array<{ uid: string; type: string; name: string }> };

    execSync(
      [
        "docker run -d",
        `--name ${CONTAINER}`,
        "-p 127.0.0.1::3000",
        "-e GF_SECURITY_ADMIN_PASSWORD=admin",
        "-e GF_ANALYTICS_REPORTING_ENABLED=false",
        "-e GF_ANALYTICS_CHECK_FOR_UPDATES=false",
        `-v ${join(dir, "provisioning")}:/etc/grafana/provisioning:ro`,
        `-v ${join(dir, "dashboards")}:/var/lib/grafana/dashboards:ro`,
        GRAFANA_IMAGE,
      ].join(" "),
      { stdio: "ignore" },
    );
    const port = execSync(`docker port ${CONTAINER} 3000/tcp`).toString().trim().split("\n")[0].split(":").pop();
    const base = `http://127.0.0.1:${port}`;
    const api = async (path: string, init?: RequestInit) => {
      const res = await fetch(`${base}${path}`, { ...init, headers: { authorization: AUTH, "content-type": "application/json", ...(init?.headers ?? {}) } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> & unknown[] };
    };

    await waitFor("Grafana to answer", async () => ((await fetch(`${base}/api/health`)).ok ? true : undefined));

    // Datasources: every declared one, with the uid and type chant gave it.
    const datasources = await waitFor("datasources", async () => {
      const { status, body } = await api("/api/datasources");
      return status === 200 && (body as unknown[]).length >= index.datasources.length ? (body as unknown as Array<{ uid: string; type: string; name: string }>) : undefined;
    });
    expect(datasources.map((d) => [d.uid, d.type, d.name]).sort()).toEqual(index.datasources.map((d) => [d.uid, d.type, d.name]).sort());

    // Dashboards: provisioned, in their folder, with every panel as built.
    for (const d of index.dashboards) {
      const { body } = await waitFor(`dashboard ${d.uid}`, async () => {
        const r = await api(`/api/dashboards/uid/${d.uid}`);
        return r.status === 200 ? r : undefined;
      });
      const meta = body.meta as { provisioned: boolean; folderTitle?: string };
      const stored = body.dashboard as { title: string; panels: Array<Record<string, unknown>>; templating: { list: unknown[] } };
      const built = JSON.parse(out.files![d.file]) as typeof stored;
      expect(meta.provisioned).toBe(true);
      if (d.folder) expect(meta.folderTitle).toBe(d.folder);
      expect(stored.title).toBe(d.title);
      const shape = (panels: Array<Record<string, unknown>>) => panels.map((p) => [p.id, p.type, p.title, p.gridPos]);
      expect(shape(stored.panels)).toEqual(shape(built.panels));
      expect(stored.templating.list.length).toBe(built.templating.list.length);
    }

    // The same JSON through the import API, under a new uid.
    const first = index.dashboards[0];
    const copy = { ...JSON.parse(out.files![first.file]), uid: `${first.uid}-api`, title: `${first.title} (API import)` };
    const imported = await api("/api/dashboards/db", { method: "POST", body: JSON.stringify({ dashboard: copy, overwrite: false }) });
    expect(imported.status).toBe(200);
    expect(imported.body.status).toBe("success");
    const back = await api(`/api/dashboards/uid/${first.uid}-api`);
    expect((back.body.dashboard as { panels: unknown[] }).panels.length).toBe(copy.panels.length);
  });
});
