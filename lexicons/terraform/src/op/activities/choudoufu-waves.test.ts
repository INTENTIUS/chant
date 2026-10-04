/**
 * choudoufu roots in a gated wave (#3459): the version floor, the one-root
 * set plan document, the commands, and which resume file comes back.
 */

import { describe, expect, test } from "vitest";
import { join } from "node:path";
import {
  MIN_CHOUDOUFU_WAVES_VERSION,
  carriedChoudoufuResume,
  choudoufuPlanSetCommand,
  choudoufuSetRootPath,
  choudoufuWaveApplyCommand,
  choudoufuWavesVersionRefusal,
  describeChoudoufuWaveExit,
  parseChoudoufuPlanSet,
  terraformPlanDigest,
} from "./terraform";

const plan = {
  format_version: "1.2",
  resource_changes: [
    {
      address: "aws_sqs_queue.q",
      mode: "managed",
      type: "aws_sqs_queue",
      name: "q",
      change: { actions: ["create"], before: null, after: { name: "q" } },
    },
  ],
};

function setDocument(overrides: Record<string, unknown> = {}, root: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format_version: "1",
    roots: [
      {
        root: "estates/e01",
        estate: "e01",
        status: "planned",
        error: "",
        changes: true,
        plan_file: ".chant/choudoufu-waves/e01/out/estates/e01.tfplan",
        log_file: ".chant/choudoufu-waves/e01/out/estates/e01.log",
        duration_ms: 10,
        plan,
        digest: "sha256:root",
        ...root,
      },
    ],
    summary: { roots: 1, planned: 1, changed: 1, failed: 0 },
    digest: "sha256:set",
    exit_code: 2,
    ...overrides,
  });
}

describe("the version floor", () => {
  test("is the release choudoufu#1754 ships in", () => {
    expect(MIN_CHOUDOUFU_WAVES_VERSION).toBe("0.22.0");
  });

  test("refuses a release older than it", () => {
    const refusal = choudoufuWavesVersionRefusal("choudoufu v0.21.0 (based on OpenTofu v1.13.0)\non darwin_arm64");
    expect(refusal).toMatch(/choudoufu 0\.21\.0 is older than v0\.22\.0/);
  });

  test("passes that release and later ones", () => {
    expect(choudoufuWavesVersionRefusal("choudoufu v0.22.0 (based on OpenTofu v1.13.0)")).toBeUndefined();
    expect(choudoufuWavesVersionRefusal("choudoufu v1.0.0 (based on OpenTofu v1.13.0)")).toBeUndefined();
  });

  test("passes a dev build, which names no release; the document's digest is the check there", () => {
    expect(choudoufuWavesVersionRefusal("OpenTofu v1.13.0-dev\non darwin_arm64")).toBeUndefined();
  });
});

describe("parseChoudoufuPlanSet", () => {
  test("binds chant's digest of the embedded plan and keeps choudoufu's set and root digests", () => {
    const parsed = parseChoudoufuPlanSet(setDocument(), { member: "e01", root: "estates/e01" });
    expect(parsed.setDigest).toBe("sha256:set");
    expect(parsed.rootDigest).toBe("sha256:root");
    expect(parsed.planDigest).toBe(terraformPlanDigest(plan));
    expect(parsed.changed).toBe(true);
    expect(parsed.changeSet.member.member).toBe("e01");
    expect(parsed.changeSet.member.nativeDigest).toBe("sha256:root");
  });

  test("refuses a document with no set digest: that choudoufu predates choudoufu#1754", () => {
    expect(() => parseChoudoufuPlanSet(setDocument({ digest: undefined }), { member: "e01", root: "estates/e01" })).toThrow(
      /carries no set digest.*v0\.22\.0/,
    );
  });

  test("refuses a root that did not plan, with choudoufu's error", () => {
    const doc = setDocument({}, { status: "failed", stage: "init", error: "provider not found", plan: null });
    expect(() => parseChoudoufuPlanSet(doc, { member: "e01", root: "estates/e01" })).toThrow(
      'choudoufu could not plan root "e01" at init: provider not found',
    );
  });

  test("refuses a document that is not about this root alone", () => {
    expect(() => parseChoudoufuPlanSet(setDocument(), { member: "e01", root: "estates/e02" })).toThrow(/not only "estates\/e02"/);
  });

  test("refuses output that is not JSON", () => {
    expect(() => parseChoudoufuPlanSet("Error: something", { member: "e01", root: "estates/e01" })).toThrow(/no JSON document/);
  });
});

describe("commands", () => {
  test("live-plan-set plans the one root, as a document", () => {
    expect(choudoufuPlanSetCommand({ binary: "choudoufu", root: "estates/e01", outDir: ".chant/choudoufu-waves/e01/out" })).toBe(
      "choudoufu live-plan-set -json -out-dir=.chant/choudoufu-waves/e01/out estates/e01",
    );
  });

  test("live-wave-apply takes the approved document, its set digest, wave 1 and the resume file", () => {
    expect(
      choudoufuWaveApplyCommand({
        binary: "choudoufu",
        planSet: ".chant/choudoufu-waves/e01/plan-set.json",
        digest: "sha256:set",
        resume: ".chant/choudoufu-waves/e01/resume-set.json",
        outDir: ".chant/choudoufu-waves/e01/out",
      }),
    ).toBe(
      "choudoufu live-wave-apply -plan-set=.chant/choudoufu-waves/e01/plan-set.json -digest=sha256:set -wave=1 " +
        "-resume=.chant/choudoufu-waves/e01/resume-set.json -out-dir=.chant/choudoufu-waves/e01/out -json",
    );
  });

  test("a root is named by its path from the project root, and only inside it", () => {
    expect(choudoufuSetRootPath("/p", join("/p", "estates", "e01"))).toBe("estates/e01");
    expect(choudoufuSetRootPath("/p", "/p")).toBeUndefined();
    expect(choudoufuSetRootPath("/p", "/elsewhere/e01")).toBeUndefined();
  });
});

describe("the carried resume file", () => {
  const resume = { format_version: "1", set_digest: "sha256:set", roots: [{ root: "estates/e01", wave: 1, outcome: "failed" }] };

  test("comes back for the same set digest", () => {
    expect(carriedChoudoufuResume({ kind: "choudoufu-wave-resume", setDigest: "sha256:set", resume }, "sha256:set")).toEqual(resume);
  });

  test("does not come back for another set digest, which choudoufu would refuse", () => {
    expect(carriedChoudoufuResume({ kind: "choudoufu-wave-resume", setDigest: "sha256:set", resume }, "sha256:other")).toBeUndefined();
  });

  test("does not come back when the file inside names another digest, or for something else carried", () => {
    const wrong = { ...resume, set_digest: "sha256:other" };
    expect(carriedChoudoufuResume({ kind: "choudoufu-wave-resume", setDigest: "sha256:set", resume: wrong }, "sha256:set")).toBeUndefined();
    expect(carriedChoudoufuResume({ kind: "something-else" }, "sha256:set")).toBeUndefined();
    expect(carriedChoudoufuResume(undefined, "sha256:set")).toBeUndefined();
  });
});

describe("describeChoudoufuWaveExit", () => {
  test("exit 3 names the moved root and both digests", () => {
    const message = describeChoudoufuWaveExit(
      3,
      { exit_code: 3, moved: [{ root: "estates/e01", approved_digest: "sha256:a", fresh_digest: "sha256:b" }] },
      "",
    );
    expect(message).toMatch(/nothing was applied/);
    expect(message).toMatch(/estates\/e01 moved: approved sha256:a, now sha256:b/);
  });

  test("exit 4 points at the resume file, and exit 1 says the command could not run", () => {
    expect(describeChoudoufuWaveExit(4, { exit_code: 4 }, "")).toMatch(/resume file records why/);
    expect(describeChoudoufuWaveExit(1, undefined, "Error: Missing options\n")).toBe(
      "choudoufu live-wave-apply could not run (exit 1) (Error: Missing options)",
    );
  });
});
