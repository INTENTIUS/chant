/**
 * GHA064: Expensive Runner Without Justification
 *
 * Flags a job hardcoded onto a pricier macOS/Windows runner (billed at a
 * multiple of Linux minutes) when none of its `run:` steps show any sign the
 * job actually needs that OS. A matrix-driven `runs-on: ${{ matrix.os }}`
 * (intentional cross-platform testing) is never flagged — only a literal,
 * hardcoded label. Efficiency (#444), not a correctness/security issue.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { getPrimaryOutput, extractRunsOnByJob, extractRunBlocks } from "./yaml-helpers";

const OS_JUSTIFICATION: Array<{ prefix: string; label: string; keywords: RegExp }> = [
  { prefix: "macos-", label: "macOS", keywords: /xcodebuild|xcode-select|\.xcodeproj|\.xcworkspace|carthage|fastlane|cocoapods|pod install|swiftpm|codesign|notarize/i },
  { prefix: "windows-", label: "Windows", keywords: /msbuild|\.sln\b|\.ps1\b|vcvarsall|nuget\s|choco\s|Set-ItemProperty|Get-ChildItem/i },
];

export const gha064: PostSynthCheck = {
  id: "GHA064",
  description: "Job hardcoded onto an expensive runner with no sign it needs that OS",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [, output] of ctx.outputs) {
      const yaml = getPrimaryOutput(output);
      const runsOnByJob = extractRunsOnByJob(yaml);
      const runBlocks = extractRunBlocks(yaml);

      for (const [jobName, labels] of runsOnByJob) {
        if (labels.some((l) => l.includes("${{"))) continue; // matrix/expression-driven — intentional

        for (const { prefix, label, keywords } of OS_JUSTIFICATION) {
          const matched = labels.find((l) => l.toLowerCase().startsWith(prefix));
          if (!matched) continue;

          const justified = runBlocks.some((r) => r.job === jobName && keywords.test(r.run));
          if (justified) break;

          diagnostics.push({
            checkId: "GHA064",
            severity: "info",
            message: `Job "${jobName}" runs on "${matched}" (a pricier ${label} runner) but no step looks ${label}-specific. Confirm it needs ${label}, or move it to a Linux runner.`,
            entity: jobName,
            lexicon: "github",
          });
          break;
        }
      }
    }

    return diagnostics;
  },
};
