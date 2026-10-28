/**
 * `--target` in the product's plan comment (#4626): repeatable, a bare
 * address or `<member>:<address>`, beside at most one member, and refused
 * when it carries spaces or shell characters. Written for the ci-products
 * post-merge pass.
 */
import { describe, expect, test } from "vitest";
import { assertProductWords, parseProductComment } from "./ci-product-words";
import { PLYWOOD } from "./__fixtures__/product-words";

const pw = assertProductWords(PLYWOOD);
const URN = "urn:pulumi:dev::shop::aws:s3/bucket:Bucket::site";

describe("--target in the plan comment (#4626)", () => {
  test("reads each --target after the plan word", () => {
    expect(parseProductComment(pw, `/plywood preview --target ${URN}`)).toEqual({ kind: "plan", targets: [URN] });
    expect(parseProductComment(pw, `/plywood preview --target shop:${URN} --target 'x'`.replace(" --target 'x'", ""))).toEqual({ kind: "plan", targets: [`shop:${URN}`] });
    expect(parseProductComment(pw, `/plywood preview shop-dev --target a --target b`)).toEqual({ kind: "plan", member: "shop-dev", targets: ["a", "b"] });
    expect(parseProductComment(pw, `/plywood preview --target module.net.aws_vpc.main["eu"]`)).toEqual({ kind: "plan", targets: ['module.net.aws_vpc.main["eu"]'] });
  });

  test("a plain plan comment is unchanged", () => {
    expect(parseProductComment(pw, "/plywood preview")).toEqual({ kind: "plan" });
  });

  test("refuses a missing address, another flag, shell characters and two members", () => {
    expect(parseProductComment(pw, "/plywood preview --target")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/needs an address/) });
    expect(parseProductComment(pw, "/plywood preview --diff")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/no other flag/) });
    for (const bad of ["a;b", "a`b`", "$(x)", "a|b", "a&b", "'a'", "-a"]) {
      expect(parseProductComment(pw, `/plywood preview --target ${bad}`), bad).toMatchObject({ kind: "refused" });
    }
    expect(parseProductComment(pw, "/plywood preview one two --target a")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/one stack at most/) });
  });
});

describe("--refresh and --target-dependents in the plan comment (#4627)", () => {
  test("read beside the targets", () => {
    expect(parseProductComment(pw, "/plywood preview --refresh")).toEqual({ kind: "plan", refresh: true });
    expect(parseProductComment(pw, "/plywood preview --target a --target-dependents --refresh")).toEqual({ kind: "plan", targets: ["a"], targetDependents: true, refresh: true });
  });

  test("--target-dependents needs a target", () => {
    expect(parseProductComment(pw, "/plywood preview --target-dependents")).toMatchObject({ kind: "refused", reason: expect.stringMatching(/widens a `--target`/) });
  });
});
