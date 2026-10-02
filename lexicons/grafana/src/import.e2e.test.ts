/**
 * "A dashboard builds to JSON that Grafana imports without edits", against
 * Grafana itself, on every release in `GRAFANA_IMAGES` (12.4 and 13.2).
 *
 * Builds each example (getting-started, and dashboards-from-declarations,
 * whose dashboards the RED, SLO and agent composites build), mounts its
 * provisioning files and dashboards into a pinned `grafana/grafana`
 * container, and asserts that Grafana provisioned every datasource and
 * dashboard, and that each stored dashboard model is the built JSON, key
 * for key, once the keys Grafana adds (`GRAFANA_INJECTED`: `id` and
 * `version`) are taken out. It then imports the same JSON a second time
 * through `POST /api/dashboards/db`, the path the UI's import uses, under
 * another uid, and compares that stored model the same way.
 *
 * Skipped, with the reason in the test name, when Docker is not running.
 * On demand: `npx vitest run --project e2e lexicons/grafana/src/import.e2e.test.ts`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import type { Serializer } from "@intentius/chant/serializer";
import { otelSerializer } from "@intentius/chant-lexicon-otel/serializer";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus/serializer";
import { grafanaSerializer } from "./serializer";
import { DockerScope, GRAFANA_IMAGES, dockerAvailable, waitFor } from "../test/e2e/containers";
import { withoutInjected } from "../test/e2e/stored-model";

const hasDocker = dockerAvailable();
const skipReason = hasDocker ? "" : "Docker is not running";
const examples = join(import.meta.dirname, "..", "examples");

/** Each example, and the serializers its build root needs. */
const EXAMPLES: Array<{ name: string; serializers: Serializer[] }> = [
  { name: "getting-started", serializers: [grafanaSerializer] },
  { name: "dashboards-from-declarations", serializers: [otelSerializer, prometheusSerializer, grafanaSerializer] },
];

const MATRIX = GRAFANA_IMAGES.flatMap((image) => EXAMPLES.map((e) => ({ ...e, image })));

describe.skipIf(!hasDocker).each(MATRIX)(`$image imports the $name dashboards without edits${skipReason ? ` (skipped: ${skipReason})` : ""}`, ({ name, serializers, image }) => {
  const scope = new DockerScope(`grafana-import-${name}`);

  afterAll(() => scope.cleanup());

  it("provisions every datasource and dashboard as built, and accepts the JSON through the import API", { timeout: 300_000 }, async () => {
    const result = await build(join(examples, name, "src"), serializers);
    expect(result.errors).toEqual([]);
    const out = result.outputs.get("grafana") as SerializerResult;
    const dir = scope.tempDir();
    for (const [file, content] of Object.entries(out.files ?? {})) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    const index = JSON.parse(out.primary) as { dashboards: Array<{ uid: string; title: string; folder?: string; file: string }>; datasources: Array<{ uid: string; type: string; name: string }> };

    const grafana = await scope.grafana({ image, provisioningDir: join(dir, "provisioning"), dashboardsDir: join(dir, "dashboards") });
    const { api } = grafana;

    // Datasources: every declared one, with the uid and type chant gave it.
    const datasources = await waitFor("datasources", async () => {
      const { status, body } = await api("/api/datasources");
      return status === 200 && (body as unknown[]).length >= index.datasources.length ? (body as Array<{ uid: string; type: string; name: string }>) : undefined;
    });
    expect(datasources.map((d) => [d.uid, d.type, d.name]).sort()).toEqual(index.datasources.map((d) => [d.uid, d.type, d.name]).sort());

    // Dashboards: provisioned, in their folder, and stored exactly as built.
    for (const d of index.dashboards) {
      const { body } = await waitFor(`dashboard ${d.uid}`, async () => {
        const r = await api(`/api/dashboards/uid/${d.uid}`);
        return r.status === 200 ? r : undefined;
      });
      const meta = body.meta as { provisioned: boolean; folderTitle?: string };
      const stored = body.dashboard as Record<string, unknown>;
      const built = JSON.parse(out.files![d.file]) as Record<string, unknown>;
      expect(meta.provisioned).toBe(true);
      if (d.folder) expect(meta.folderTitle).toBe(d.folder);
      expect(typeof stored.id, `${d.uid}: Grafana assigns the id`).toBe("number");
      expect(stored.version, `${d.uid}: Grafana's first version`).toBe(1);
      expect(withoutInjected(stored), `${image} stored ${d.uid} differently from the build`).toStrictEqual(built);
    }

    // The same JSON through the import API, under a new uid.
    const first = index.dashboards[0];
    const copy = { ...(JSON.parse(out.files![first.file]) as Record<string, unknown>), uid: `${first.uid}-api`, title: `${first.title} (API import)` };
    const imported = await api("/api/dashboards/db", { method: "POST", body: JSON.stringify({ dashboard: copy, overwrite: false }) });
    expect(imported.status).toBe(200);
    expect(imported.body.status).toBe("success");
    const back = await api(`/api/dashboards/uid/${first.uid}-api`);
    expect(back.status).toBe(200);
    expect(withoutInjected(back.body.dashboard as Record<string, unknown>), `${image} stored the API import differently from the JSON sent`).toStrictEqual(copy);
  });
});
