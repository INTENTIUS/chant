import { afterEach, describe, expect, test } from "vitest";
import {
  activeProductWords,
  approveLine,
  assertProductWords,
  CHANT_WORDS,
  commentLine,
  overrideLine,
  parseProductComment,
  productStatusContext,
  productWordsProblems,
  resolveProductWords,
  setActiveProductWords,
  withProductWords,
} from "./ci-product-words";
import { PLYWOOD, TERRAGUCCI, YODEL } from "./__fixtures__/product-words";

afterEach(() => {
  setActiveProductWords(undefined);
});

describe("a CI product's words (#4550)", () => {
  test("every slot defaults to chant's word", () => {
    expect(resolveProductWords({})).toEqual(CHANT_WORDS);
    expect(productStatusContext(CHANT_WORDS, "plan")).toBe("chant/plan");
    expect(commentLine(CHANT_WORDS, "apply")).toBe("/chant apply");
  });

  test("a product's status contexts, comments and approve lines are its own", () => {
    const w = assertProductWords(PLYWOOD);
    expect(productStatusContext(w, "plan")).toBe("plywood/preview");
    expect(productStatusContext(w, "plan", "shop-dev")).toBe("plywood/preview/shop-dev");
    expect(commentLine(w, "apply")).toBe("/plywood up");
    expect(approveLine(w, { op: "pulumi-up", gate: "wave-2", digest: "sha256:abc" })).toBe("plywood approve wave-2 --plan sha256:abc --sign");
    expect(overrideLine(w, { op: "policy-override", gate: "up", rules: ["b", "a"] })).toBe("plywood override up --rule a --rule b --reason <text>");
  });

  test("the approve and override templates take {target} (#4574)", () => {
    const yodel = assertProductWords({ product: "yodel", approve: "yodel approve {target} --plan {digest}", override: "yodel override {target} --rule {rule} --reason {reason}" });
    expect(approveLine(yodel, { op: "migrate", gate: "wave-1", digest: "sha256:abc", target: "prod/acme" })).toBe("yodel approve prod/acme --plan sha256:abc");
    expect(overrideLine(yodel, { op: "policy-override", rules: ["no-drop"], target: "prod/acme", reason: "planned" })).toBe("yodel override prod/acme --rule no-drop --reason planned");
  });

  test("the apply mode follows the words: waves on merge for a product with an op or per-wave approvals, else a release (#4601)", () => {
    expect(CHANT_WORDS.applyMode).toBe("release");
    expect(assertProductWords(PLYWOOD).applyMode).toBe("on-merge");
    expect(assertProductWords(TERRAGUCCI).applyMode).toBe("on-merge");
    expect(assertProductWords(YODEL).applyMode).toBe("on-merge");
    expect(assertProductWords({ product: "acme" }).applyMode).toBe("release");
    expect(assertProductWords({ ...PLYWOOD, applyMode: "before-merge" }).applyMode).toBe("before-merge");
    expect(productWordsProblems(resolveProductWords({ applyMode: "later" as never })).some((p) => /applyMode is "later"/.test(p))).toBe(true);
  });

  test("words that could reach a shell or collide are refused", () => {
    const bad = resolveProductWords({ product: "Ply wood", stages: { plan: "apply" }, commands: { "$(x)": "apply", go: "deploy" as never }, approve: "x {op} {who}; rm" });
    const problems = productWordsProblems(bad, { jobs: ["plan"] });
    expect(problems.some((p) => /product is "Ply wood"/.test(p))).toBe(true);
    expect(problems.some((p) => /stages.apply and stages.plan are both "apply"/.test(p))).toBe(true);
    expect(problems.some((p) => /commands.\$\(x\)/.test(p))).toBe(true);
    expect(problems.some((p) => /needs a apply job/.test(p))).toBe(true);
    expect(problems.some((p) => /\{who\}/.test(p))).toBe(true);
    expect(problems.some((p) => /shell syntax/.test(p))).toBe(true);
    expect(() => assertProductWords(PLYWOOD, { jobs: ["plan"] })).toThrow(/commands.up needs a apply job/);
  });

  test("the active words are set for a command and put back after it", async () => {
    expect(activeProductWords()).toBe(CHANT_WORDS);
    const seen = await withProductWords(PLYWOOD, async () => activeProductWords().product);
    expect(seen).toBe("plywood");
    expect(activeProductWords()).toBe(CHANT_WORDS);
  });
});

describe("the comment grammar (moved from terragucci's comment.ts)", () => {
  const tg = assertProductWords(TERRAGUCCI);
  const pw = assertProductWords(PLYWOOD);

  test("reads the product's commands and nothing addressed elsewhere", () => {
    expect(parseProductComment(pw, "/plywood up")).toEqual({ kind: "apply" });
    expect(parseProductComment(pw, "/plywood up wave-2")).toEqual({ kind: "apply", wave: 2 });
    expect(parseProductComment(pw, "/plywood preview shop-dev")).toEqual({ kind: "plan", member: "shop-dev" });
    expect(parseProductComment(pw, "/terragucci apply")).toBeUndefined();
    expect(parseProductComment(tg, "/terragucci lock")).toEqual({ kind: "lock" });
    expect(parseProductComment(tg, "/terragucci agent rename the bucket")).toEqual({ kind: "agent", ask: "rename the bucket" });
  });

  test("refuses what it never runs, and anything unsafe", () => {
    expect(parseProductComment(pw, "/plywood approve up")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/never runs `approve`/) });
    expect(parseProductComment(pw, "/plywood up\nrm -rf /")).toMatchObject({ kind: "refused" });
    expect(parseProductComment(pw, "/plywood preview ../etc")).toMatchObject({ kind: "refused" });
    expect(parseProductComment(pw, "/plywood up now")).toMatchObject({ kind: "refused" });
    expect(parseProductComment(pw, "/plywood lock everything")).toMatchObject({ kind: "refused" });
  });

  test("an alias reads only where its variable turns it on", () => {
    expect(parseProductComment(tg, "atlantis plan -d envs/dev/orders")).toBeUndefined();
    expect(parseProductComment(tg, "atlantis plan -d ./envs/dev/orders/", { TG_ATLANTIS_COMMENTS: "1" })).toEqual({ kind: "plan", member: "envs/dev/orders" });
    expect(parseProductComment(tg, "atlantis apply", { TG_ATLANTIS_COMMENTS: "1" })).toEqual({ kind: "apply" });
    expect(parseProductComment(tg, "atlantis plan -w staging", { TG_ATLANTIS_COMMENTS: "1" })).toMatchObject({ kind: "refused" });
  });
});
