/** #4622: a scheduled Op's job keeps named artifacts after its run, with the upload action Forgejo runs. */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpPipeline } from "./generate-op-pipeline";
import { ACTION_PINS } from "@intentius/chant/action-pins";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";

type Step = { if?: string; uses?: string; run?: string; with?: Record<string, unknown> };

describe("scheduled Op artifacts on Forgejo (#4622)", () => {
  test("each artifact is an upload-artifact v3 step after the run, kept whatever the run ended with", () => {
    const spec: ScheduledOpSpec = { name: "drift", schedule: "0 6 * * *", artifacts: [{ name: "drift-report", paths: ["reports/"], retentionDays: 7 }] };
    const doc = parseYAML(generateForgejoOpPipeline([spec]).files[0]!.yaml) as { jobs: Record<string, { steps: Step[] }> };
    const s = doc.jobs.drift!.steps;
    const run = s.findIndex((x) => x.run?.includes("chant run drift"));
    const up = s.findIndex((x) => x.uses?.startsWith("actions/upload-artifact@") || x.uses?.includes("/upload-artifact@"));
    expect(up).toBeGreaterThan(run);
    expect(s[up]!.uses).toContain(ACTION_PINS.uploadArtifact3.sha);
    expect(s[up]!.if).toBe("always()");
    expect(s[up]!.with).toEqual({ name: "drift-report", path: "reports/", "if-no-files-found": "ignore", "retention-days": 7 });
  });
});
