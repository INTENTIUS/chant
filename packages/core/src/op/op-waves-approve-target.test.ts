/**
 * #4574: under a product's words, a waiting wave's approve line fills
 * `{target}`: the run's target for a wave of one run, the wave's name for a
 * wave of several. chant's own line is what it was.
 */
import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertProductWords, setActiveProductWords } from "../ci-product-words";
import { waveApproveTarget, type OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveExec, type OpWaveShowAtBase } from "./op-waves-run";
import { approveCommand, memoryGateLedgerPort } from "./gate";
import { opWaveNotifyFields } from "./op-waves-notify";

const YODEL = assertProductWords({
  product: "yodel",
  noun: ["environment", "environments"],
  approve: "yodel approve {target} --plan {digest} {sign}",
  override: "yodel override {target} --rule {rule} --reason <text>",
});

const spec: OpWavesSpec = {
  name: "yodel-apply",
  op: "migrate-dev",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "always" },
    { name: "prod", runs: [{ target: "prod/acme" }, { target: "prod/beta" }], gate: "always" },
  ],
};

const digest = (n: string) => `sha256:${n.repeat(64)}`;

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-target-"));
  const exec: OpWaveExec = (argv, dir) => {
    if (argv[1] === "plan") writeFileSync(join(dir, argv[4]!), JSON.stringify({ planDigest: digest(argv[2] === "dev" ? "a" : argv[2] === "prod/acme" ? "b" : "c") }));
    return 0;
  };
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });
  return { cwd, exec, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

async function waiting(wave: number) {
  const h = harness();
  const lines: string[] = [];
  const result = await runOpWave({ spec, specFile: "waves.json", wave, cwd: h.cwd, exec: h.exec, show: h.show, gates: memoryGateLedgerPort(), log: (l) => lines.push(l) });
  h.done();
  expect(result.exitCode).toBe(3);
  return { result, said: lines.find((l) => l.startsWith(`Nothing in wave ${wave} or after it ran.`)) };
}

afterEach(() => {
  setActiveProductWords(undefined);
});

describe("a waiting wave's approve line names its target (#4574)", () => {
  test("a wave of one run names the run's target under a product's words", async () => {
    setActiveProductWords(YODEL);
    const { result, said } = await waiting(1);
    const d = result.decision!.digest;
    expect(result.decision!.approve).toBe(`yodel approve dev --plan ${d}`);
    expect(said).toBe(`Nothing in wave 1 or after it ran. Read the plans, then approve: yodel approve dev --plan ${d} (with --resume, the approval also starts this job again)`);
  });

  test("a wave of several runs names the wave, approved once for its set digest", async () => {
    setActiveProductWords(YODEL);
    const { result } = await waiting(2);
    expect(result.decision!.approve).toBe(`yodel approve prod --plan ${result.decision!.digest}`);
  });

  test("chant's own words keep chant's line", async () => {
    const one = await waiting(1);
    expect(one.result.decision!.approve).toBe(`chant approve yodel-apply ${one.result.decision!.gate} --plan ${one.result.decision!.digest}`);
    const several = await waiting(2);
    expect(several.result.decision!.approve).toBe(`chant approve yodel-apply ${several.result.decision!.gate} --plan ${several.result.decision!.digest}`);
  });

  test("the notify fallback names the same target", () => {
    setActiveProductWords(YODEL);
    const decision = { wave: 1, name: "dev", op: "yodel-apply", gate: "yodel-apply-wave-1", policy: "always" as const, approval: "ledger" as const, policySource: "base" as const, base: "b", digest: digest("d"), members: [{ member: "dev", planDigest: digest("a") }], status: "waiting" as const };
    const fields = opWaveNotifyFields(spec, 1, { result: { exitCode: 3, decision, applied: [], failed: [], moved: [], hooks: [] } as never }, {}, YODEL);
    expect(fields!.approve).toMatchObject({ command: `yodel approve dev --plan ${digest("d")}` });
  });
});

describe("approveCommand's target (#4574)", () => {
  test("fills a product's {target}; chant's line leaves it out", () => {
    expect(approveCommand("op", "g", undefined, digest("e"), false, "dev")).toBe(`chant approve op g --plan ${digest("e")}`);
    expect(approveCommand("op", "g", undefined, digest("e"), true, "dev")).toBe(`chant approve op g --plan ${digest("e")} --sign`);
    setActiveProductWords(YODEL);
    expect(approveCommand("op", "g", undefined, digest("e"), false, "dev")).toBe(`yodel approve dev --plan ${digest("e")}`);
    expect(approveCommand("op", "g", undefined, digest("e"), true, "dev")).toBe(`yodel approve dev --plan ${digest("e")} --sign`);
    // A component gate's environment wins, as before.
    expect(approveCommand("op", "g", "prod", digest("e"), false, "dev")).toBe(`yodel approve prod --plan ${digest("e")}`);
    // With no target the line has no doubled space.
    expect(approveCommand("op", "g", undefined, digest("e"))).toBe(`yodel approve --plan ${digest("e")}`);
  });

  test("waveApproveTarget: the one run's target, else the wave's name", () => {
    expect(waveApproveTarget("dev", ["dev"])).toBe("dev");
    expect(waveApproveTarget("prod", ["prod/acme"])).toBe("prod/acme");
    expect(waveApproveTarget("prod", ["prod/acme", "prod/beta"])).toBe("prod");
    expect(waveApproveTarget("discover", [])).toBe("discover");
  });
});
