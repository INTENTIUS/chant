import { describe, expect, test } from "vitest";
import { CI_TOOL_SHA256 } from "@intentius/chant/ci-image";
import { CHOUDOUFU_CI_VERSION, choudoufuInstallLine } from "./ci-setup";

describe("choudoufuInstallLine", () => {
  test("checks the archive against the release's SHA256SUMS and chant's recorded sha256 (#4784)", () => {
    const line = choudoufuInstallLine();
    expect(line.startsWith("command -v choudoufu >/dev/null 2>&1 || { ")).toBe(true);
    expect(line).toContain(`https://github.com/INTENTIUS/choudoufu/releases/download/v${CHOUDOUFU_CI_VERSION}/SHA256SUMS`);
    expect(line).toContain(`(amd64) want=${CI_TOOL_SHA256[`choudoufu-${CHOUDOUFU_CI_VERSION}-linux-amd64`]} ;;`);
    expect(line).toContain(`(arm64) want=${CI_TOOL_SHA256[`choudoufu-${CHOUDOUFU_CI_VERSION}-linux-arm64`]} ;;`);
    expect(line).toContain('sha256sum -c -');
    expect(line).toContain(`ln -sf "/opt/chant/choudoufu-${CHOUDOUFU_CI_VERSION}/choudoufu" /usr/local/bin/choudoufu`);
  });

  test("a version chant records no sha256 for needs one", () => {
    expect(() => choudoufuInstallLine("0.32.0")).toThrow(/no recorded sha256 for choudoufu 0.32.0/);
    expect(choudoufuInstallLine("0.32.0", { sha256: { amd64: "a".repeat(64), arm64: "b".repeat(64) } })).toContain(`want=${"a".repeat(64)}`);
  });
});
