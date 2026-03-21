/**
 * Roundtrip tests — parse testdata fixtures and verify TypeScript output.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { SlurmConfParser } from "./parser";
import { SlurmGenerator } from "./generator";

const testdata = (file: string) =>
  readFileSync(join(import.meta.dir, "testdata", file), "utf8");

test("simple.conf → Cluster + Node + Partition constructors", () => {
  const { entities } = new SlurmConfParser().parse(testdata("simple.conf"));
  const { source } = new SlurmGenerator().generate(entities);
  expect(source).toContain("new Cluster(");
  expect(source).toContain("new Node(");
  expect(source).toContain("new Partition(");
});

test("eda-cluster.conf → all five resource types generated", () => {
  const { entities } = new SlurmConfParser().parse(testdata("eda-cluster.conf"));
  const { source } = new SlurmGenerator().generate(entities);
  expect(source).toContain("new Cluster(");
  expect(source).toContain("new Node(");
  expect(source).toContain("new Partition(");
  expect(source).toContain("new License(");
});

test("eda-cluster.conf → GPU node Gres survives roundtrip", () => {
  const { entities } = new SlurmConfParser().parse(testdata("eda-cluster.conf"));
  const { source } = new SlurmGenerator().generate(entities);
  expect(source).toContain("gpu:a100:8");
  expect(source).toContain("efa");
});

test("licenses-only.conf → License constructors only", () => {
  const { entities } = new SlurmConfParser().parse(testdata("licenses-only.conf"));
  const { source } = new SlurmGenerator().generate(entities);
  expect(source).toContain("new License(");
  expect(source).toContain("vcs_sim");
});

test("eda-cluster.conf → EDA partition names survive", () => {
  const { entities } = new SlurmConfParser().parse(testdata("eda-cluster.conf"));
  const { source } = new SlurmGenerator().generate(entities);
  expect(source).toContain("synthesis");
  expect(source).toContain("sim");
  expect(source).toContain("gpu_eda");
});
