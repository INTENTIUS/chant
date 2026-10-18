/**
 * What each component would apply, as a digest (#4081), and which of an
 * earlier attempt's progress holds against it.
 */

import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentInputDigests, progressThatCarries } from "./fan-out-inputs";
import type { DriverComponent } from "./driver";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "fan-out-inputs-"));
  mkdirSync(join(root, "dist"));
  for (const name of ["net", "cluster", "app"]) writeFileSync(join(root, "dist", `${name}.json`), `{"name":"${name}"}`);
  return root;
}

const component = (name: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: name, template: `dist/${name}.json`, ...extra }] }],
});

const estate = [component("net"), component("cluster", ["net"]), component("app", ["cluster"])];

describe("componentInputDigests", () => {
  test("is stable for the same project, environment and files", () => {
    const root = project();
    expect(componentInputDigests(estate, { projectRoot: root, env: "prod" })).toEqual(
      componentInputDigests(estate, { projectRoot: root, env: "prod" }),
    );
  });

  test("covers the bytes of a file a step input names, and everything downstream of it", () => {
    const root = project();
    const before = componentInputDigests(estate, { projectRoot: root, env: "prod" });
    writeFileSync(join(root, "dist", "cluster.json"), `{"name":"cluster","queue":true}`);
    const after = componentInputDigests(estate, { projectRoot: root, env: "prod" });
    expect(after.net).toBe(before.net);
    expect(after.cluster).not.toBe(before.cluster);
    expect(after.app).not.toBe(before.app);
  });

  test("covers a directory a step names, by its files", () => {
    const root = project();
    const chart = [component("chart", [], { chart: "dist" })];
    const before = componentInputDigests(chart, { projectRoot: root, env: "prod" });
    writeFileSync(join(root, "dist", "app.json"), "{}");
    expect(componentInputDigests(chart, { projectRoot: root, env: "prod" }).chart).not.toBe(before.chart);
  });

  test("covers the environment and the authored steps", () => {
    const root = project();
    const prod = componentInputDigests(estate, { projectRoot: root, env: "prod" });
    expect(componentInputDigests(estate, { projectRoot: root, env: "staging" }).net).not.toBe(prod.net);
    const moved = [component("net", [], { inputs: { size: 2 } }), ...estate.slice(1)];
    expect(componentInputDigests(moved, { projectRoot: root, env: "prod" }).net).not.toBe(prod.net);
  });

  test("ignores a string that is not a file, a path outside the project, and the phase name", () => {
    const root = project();
    mkdirSync(join(root, "Apply"));
    const before = componentInputDigests(estate, { projectRoot: root, env: "prod" });
    writeFileSync(join(root, "Apply", "x"), "changes nothing");
    expect(componentInputDigests(estate, { projectRoot: root, env: "prod" })).toEqual(before);
    const outside = [component("net", [], { other: "../elsewhere.json" })];
    expect(() => componentInputDigests(outside, { projectRoot: root, env: "prod" })).not.toThrow();
  });
});

describe("progressThatCarries", () => {
  test("carries a component only when its recorded input is the one it has now", () => {
    const split = progressThatCarries(
      { completed: ["net", "cluster", "app"], inputs: { net: "a", cluster: "b" } },
      { net: "a", cluster: "B", app: "c" },
    );
    expect(split).toEqual({ carried: ["net"], changed: ["app", "cluster"], unrecorded: false });
  });

  test("a record with no input digests carries nothing", () => {
    expect(progressThatCarries({ completed: ["net"] }, { net: "a" })).toEqual({ carried: [], changed: ["net"], unrecorded: true });
  });
});
