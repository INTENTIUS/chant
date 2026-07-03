/**
 * Validates the pilot components (#555, #558, epic #551) two ways:
 *
 * 1. Each pilot's TypeScript authoring form projects to JSON that validates
 *    against component.schema.json (draft 2020-12, via the same ajv 2020
 *    setup as ../component-schema.test.ts).
 * 2. That projection is byte-identical (as data) to the corresponding
 *    existing fixture under ../__fixtures__/ — so the fixture stays the one
 *    authoritative JSON projection per pilot rather than a second, divergent
 *    copy. If a pilot's composition changes, the fixture is the file to
 *    update; this test catches the two drifting apart.
 *
 * Includes the original three pilots (#555 — Neo4j fan-out, DynamoDB sticky
 * apply, ALB/ECS cross-stack) plus the fourth validation component #558 added
 * (image-processor-lambda) to prove the sprawl metric holds beyond the
 * original three; see ../SPRAWL-VALIDATION.md. Also includes the #561
 * JAR-producer / EMR-consumer pair (../pilots/jar-emr.pilot.ts) — the epic's
 * worked cross-component artifact output example.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import componentSchema from "../component.schema.json";
import { neo4jCluster } from "./neo4j-fanout.pilot";
import { ordersTable } from "./dynamodb.pilot";
import { searchService } from "./alb-ecs.pilot";
import { imageProcessor } from "./lambda.pilot";
import { jarLib, emrJob } from "./jar-emr.pilot";
import { projectToJson } from "./project";
import type { Component } from "../component";

const FIXTURES_DIR = join(import.meta.dirname, "..", "__fixtures__");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8"));
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(componentSchema);

const pilots: Array<{ name: string; component: Component; fixture: string }> = [
  { name: "neo4j per-instance fan-out", component: neo4jCluster, fixture: "neo4j-fanout.json" },
  { name: "DynamoDB sticky apply", component: ordersTable, fixture: "dynamodb-infra.json" },
  { name: "ALB/ECS target", component: searchService, fixture: "alb-ecs-service.json" },
  { name: "image-processor Lambda (#558 fourth component)", component: imageProcessor, fixture: "lambda-image-processor.json" },
  { name: "jar-lib producer (#561 cross-component pair)", component: jarLib, fixture: "jar-lib-producer.json" },
  { name: "emr-job consumer (#561 cross-component pair)", component: emrJob, fixture: "emr-job-consumer.json" },
];

describe("Pilot component definitions", () => {
  it.each(pilots.map((p) => [p.name, p] as const))(
    "%s: TypeScript authoring form projects to valid JSON",
    (_name, pilot) => {
      const projected = projectToJson(pilot.component);
      const valid = validate(projected);
      if (!valid) {
        throw new Error(`${pilot.name} failed schema validation: ${ajv.errorsText(validate.errors)}`);
      }
      expect(valid).toBe(true);
    },
  );

  it.each(pilots.map((p) => [p.name, p] as const))(
    "%s: projection matches the authoritative __fixtures__ JSON (no divergent copy)",
    (_name, pilot) => {
      const projected = projectToJson(pilot.component);
      const fixture = loadFixture(pilot.fixture);
      // The fixture carries $schema/contractVersion metadata the illustrative
      // authoring form doesn't reproduce (those are document-level
      // provenance fields, not composition content); strip them from the
      // fixture side before comparing so this asserts the two never diverge
      // on the parts that matter — name/archetype/dependsOn/build/deploy/rollback.
      const { $schema: _s, contractVersion: _v, ...fixtureContent } = fixture as Record<string, unknown>;
      expect(projected).toEqual(fixtureContent);
    },
  );

  it("each pilot exercises its intended epic axis (build presence / archetype / fan-out shape)", () => {
    // Neo4j: fan-out — more than one instance phase, nested no build (infra).
    expect(neo4jCluster.archetype).toBe("infra");
    expect(neo4jCluster.build).toBeUndefined();
    expect(neo4jCluster.deploy.length).toBeGreaterThan(1);

    // DynamoDB: sticky apply — no build, cfn-deploy carries onReplace/stageGsi.
    expect(ordersTable.archetype).toBe("infra");
    expect(ordersTable.build).toBeUndefined();
    const applyStep = ordersTable.deploy[0]!.steps[0] as { onReplace?: string; stageGsi?: boolean };
    expect(applyStep.onReplace).toBe("block");
    expect(applyStep.stageGsi).toBe(true);

    // ALB/ECS: build present, cross-stack wiring present, service archetype.
    expect(searchService.archetype).toBe("service");
    expect(searchService.build).toBeDefined();
    expect(searchService.dependsOn).toContain("shared-alb");
    const applyPhase = searchService.deploy.find((p) => p.phase === "Apply")!;
    const cfnStep = applyPhase.steps[0] as { inputs?: Record<string, unknown> };
    expect(cfnStep.inputs?.listenerArn).toEqual({ stackOutput: { stack: "shared-alb", name: "ListenerArn" } });
  });

  it("image-processor Lambda (#558): build present, service archetype, apply has no cfn-deploy at all — the fourth component's distinguishing shape", () => {
    expect(imageProcessor.archetype).toBe("service");
    expect(imageProcessor.build).toBeDefined();
    const applyPhase = imageProcessor.deploy.find((p) => p.phase === "Apply")!;
    expect(applyPhase.steps.map((s) => (s as { kind: string }).kind)).toEqual(["lambda-deploy"]);
    expect(applyPhase.steps.some((s) => (s as { kind: string }).kind === "cfn-deploy")).toBe(false);
  });

  it("jar-lib (#561): producer-library archetype, publish-only deploy — build -> publish, no apply phase at all", () => {
    expect(jarLib.archetype).toBe("producer-library");
    expect(jarLib.build).toBeDefined();
    expect(jarLib.deploy).toHaveLength(1);
    expect(jarLib.deploy[0]!.phase).toBe("Publish");
    expect(jarLib.deploy[0]!.steps.map((s) => (s as { kind: string }).kind)).toEqual(["publish-artifact"]);
  });

  it("emr-job (#561): infra archetype, depends on jar-lib, and references the producer's published artifact by @<component>.publish.uri — the cross-component wiring this issue adds", () => {
    expect(emrJob.archetype).toBe("infra");
    expect(emrJob.dependsOn).toEqual(["jar-lib"]);
    const submitPhase = emrJob.deploy.find((p) => p.phase === "Submit")!;
    const submitStep = submitPhase.steps[0] as { kind: string; jar: string };
    expect(submitStep.kind).toBe("emr-start-job-run");
    expect(submitStep.jar).toBe("@jar-lib.publish.uri");
  });
});
