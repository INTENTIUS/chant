/**
 * #5155: `release.version.ranges: "train"` takes each workspace package's
 * label from a recorded release train.
 */

import { afterAll, describe, expect, test } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendReleaseTrain, trainDigest, type ReleaseTrainRecord } from "./release-train";
import { trainLabelCandidates, trainLabels, TrainLabelsError } from "./train-range-labels";
import { stampReleaseVersion } from "../lifecycle/release-version";
import { TestRepo } from "./trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const cfg = (ranges: string) => `export default { environments: ["npm"], release: { version: { packages: ["."], ranges: "${ranges}" } } };\n`;

/** Members lex and core, one package each; lex depends on core. */
async function setup(): Promise<{ r: TestRepo; lex: string }> {
  const r = new TestRepo("train-range-labels");
  repos.push(r);
  r.write("chant.workspace.json", JSON.stringify({ name: "acme", schema: 1, members: [{ name: "core", dir: "core", kind: "chant" }, { name: "lex", dir: "lex", kind: "chant" }, { name: "docs", dir: "docs", kind: "chant" }] }, null, 2));
  r.write("core/chant.config.ts", cfg("train"));
  r.write("core/package.json", JSON.stringify({ name: "@acme/core", version: "1.0.0" }, null, 2));
  r.write("lex/chant.config.ts", cfg("train"));
  r.write("lex/package.json", JSON.stringify({ name: "@acme/lex", version: "1.0.0", dependencies: { "@acme/core": "^1.0.0", "@acme/docs": "^1.0.0", zod: "^3.0.0" } }, null, 2));
  r.write("docs/chant.config.ts", `export default { environments: ["npm"] };\n`);
  r.commit("init");
  const members = [
    { member: "core", releaseDigest: "sha256:a", commit: "c", label: "1.2.3" },
    { member: "docs", releaseDigest: "sha256:c", commit: "c", label: null },
    { member: "lex", releaseDigest: "sha256:b", commit: "c", label: "1.4.0" },
  ];
  const record: ReleaseTrainRecord = { version: 1, id: "train-1", env: "npm", timestamp: "2026-11-15T10:00:00.000Z", actor: "alice", members, trainDigest: trainDigest(members) };
  await appendReleaseTrain(r.dir, record);
  return { r, lex: join(r.dir, "lex") };
}

describe("labels from a train", () => {
  test("a package takes the label of the member that owns it; a member with no release.version owns none", async () => {
    const { lex } = await setup();
    expect(await trainLabels(lex, "train-1", ["@acme/lex"], "1.4.0")).toEqual({ "@acme/core": "1.2.3", "@acme/lex": "1.4.0" });
    const { files } = stampReleaseVersion({ cwd: lex, config: { packages: ["."], ranges: "train" }, label: "1.4.0", train: await trainLabels(lex, "train-1", ["@acme/lex"], "1.4.0") });
    expect(files).toEqual(["package.json"]);
    expect(JSON.parse(readFileSync(join(lex, "package.json"), "utf-8")).dependencies).toEqual({ "@acme/core": "^1.2.3", "@acme/docs": "^1.0.0", zod: "^3.0.0" });
  });

  test("an unknown train, and a train that does not pin the member at the label, are refused", async () => {
    const { lex } = await setup();
    await expect(trainLabels(lex, "nope", ["@acme/lex"], "1.4.0")).rejects.toMatchObject({ code: "release-train-unknown" });
    await expect(trainLabels(lex, "train-1", ["@acme/lex"], "1.5.0")).rejects.toThrow(TrainLabelsError);
    await expect(trainLabels(lex, "train-1", ["@acme/other"], "1.4.0")).rejects.toMatchObject({ code: "release-train-not-pinned" });
  });

  test("the publish's candidates are the trains that pin a release at the label", async () => {
    const { lex } = await setup();
    expect(await trainLabelCandidates(lex, "1.4.0")).toEqual([{ "@acme/core": "1.2.3", "@acme/lex": "1.4.0" }]);
    expect(await trainLabelCandidates(lex, "9.9.9")).toEqual([]);
  });
});
