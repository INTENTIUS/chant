import { describe, test, expect } from "vitest";
import { applyComposites } from "./rewriter";
import type { TemplateIR } from "@intentius/chant/import/parser";

function nodeJob(id: string, opts: { image: string; script: string[]; stage?: string }): TemplateIR["resources"][0] {
  return {
    logicalId: id,
    type: "GitLab::CI::Job",
    properties: {
      image: opts.image,
      script: opts.script,
      ...(opts.stage ? { stage: opts.stage } : {}),
    },
  };
}

describe("applyComposites — NodePipeline", () => {
  test("matches 2-job build+test shape", () => {
    const ir: TemplateIR = {
      resources: [
        nodeJob("build", { image: "node:22", script: ["npm ci", "npm run build"], stage: "build" }),
        nodeJob("test", { image: "node:22", script: ["npm ci", "npm test"], stage: "test" }),
      ],
      parameters: [],
    };
    const r = applyComposites(ir);
    const composites = r.ir.resources.filter((res) => res.type === "GitLab::Composite::NodePipeline");
    expect(composites).toHaveLength(1);
    expect(r.ir.resources.filter((res) => res.type === "GitLab::CI::Job")).toHaveLength(0);
    expect(r.provenance[0].rule).toBe("MIG-COMPOSITE-NODEPIPELINE");
  });

  test("rejects non-node images", () => {
    const ir: TemplateIR = {
      resources: [
        nodeJob("build", { image: "alpine:3", script: ["npm ci", "npm run build"] }),
        nodeJob("test", { image: "node:22", script: ["npm ci", "npm test"] }),
      ],
      parameters: [],
    };
    const r = applyComposites(ir);
    expect(r.ir.resources.filter((res) => res.type === "GitLab::CI::Job")).toHaveLength(2);
  });

  test("rejects jobs without install step", () => {
    const ir: TemplateIR = {
      resources: [
        nodeJob("build", { image: "node:22", script: ["npm run build"] }),
        nodeJob("test", { image: "node:22", script: ["npm test"] }),
      ],
      parameters: [],
    };
    const r = applyComposites(ir);
    expect(r.ir.resources.filter((res) => res.type === "GitLab::CI::Job")).toHaveLength(2);
  });

  test("detects pnpm package manager", () => {
    const ir: TemplateIR = {
      resources: [
        nodeJob("build", { image: "node:20", script: ["pnpm install", "pnpm build"] }),
        nodeJob("test", { image: "node:20", script: ["pnpm install", "pnpm test"] }),
      ],
      parameters: [],
    };
    const r = applyComposites(ir);
    const composite = r.ir.resources.find((res) => res.type === "GitLab::Composite::NodePipeline");
    expect(composite?.properties.packageManager).toBe("pnpm");
  });
});

describe("applyComposites — NodeCI", () => {
  test("matches single-job node setup", () => {
    const ir: TemplateIR = {
      resources: [
        nodeJob("ci", { image: "node:20", script: ["npm ci", "npm test"] }),
      ],
      parameters: [],
    };
    const r = applyComposites(ir);
    const composites = r.ir.resources.filter((res) => res.type === "GitLab::Composite::NodeCI");
    expect(composites).toHaveLength(1);
    expect(r.provenance[0].rule).toBe("MIG-COMPOSITE-NODECI");
  });

  test("falls back to raw jobs when nothing matches", () => {
    const ir: TemplateIR = {
      resources: [
        nodeJob("a", { image: "ubuntu:24.04", script: ["make"] }),
        nodeJob("b", { image: "ubuntu:24.04", script: ["./deploy.sh"] }),
        nodeJob("c", { image: "ubuntu:24.04", script: ["./teardown.sh"] }),
      ],
      parameters: [],
    };
    const r = applyComposites(ir);
    expect(r.ir.resources).toHaveLength(3);
    expect(r.provenance).toHaveLength(0);
  });
});
