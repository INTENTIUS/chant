/** The action job on Forgejo (#4654): the GitHub generator's job, reading Forgejo's payload, with no author check, and the same dispatch inputs. */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "shop", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "pulumi-up", stack: "shop/prod-us" }] }] },
];

const WORDS = { product: "plywood", noun: ["stack", "stacks"] as [string, string], commands: { preview: "plan" as const, action: "action" as const }, bin: "npx --no-install plywood" };

type Doc = { on: Record<string, { inputs?: Record<string, unknown> }>; jobs: Record<string, { if?: string; steps: Array<{ run?: string }> }> };

describe("the Forgejo workflow's action job", () => {
  const yaml = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { words: WORDS, actionJob: true } }).yaml;
  const doc = parseYAML(yaml) as Doc;

  test("the dispatch carries the stack and action inputs, and the comment check asks no author", () => {
    expect(Object.keys(doc.on.workflow_dispatch!.inputs!)).toEqual(["stack", "action"]);
    expect(doc.jobs.action!.if).toContain("startsWith(github.event.comment.body, '/plywood action ')");
    expect(doc.jobs.action!.if).not.toContain("author_association");
    expect(doc.jobs.action!.steps.at(-1)!.run).toContain("npx --no-install plywood action --from-event");
  });

  test("golden", async () => {
    await expect(yaml).toMatchFileSnapshot("./__golden__/pr-loop-action.forgejo.yml");
  });
});
