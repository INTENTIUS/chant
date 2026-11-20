import type { LintDiagnostic } from "./rule";
import type { EnvironmentDeclaration } from "../config-environments";

/**
 * COR027: Canary Without Soak Checks (#5327)
 *
 * A canary holds the steps after it through its soak: a pipeline stage
 * marked `canary` reads its soak's checks before any later stage opens its
 * gate. An entry of a member's `environments` in `chant.config.ts` can be
 * marked `canary: true`, and it carries no soak, so it holds nothing. That
 * existing config keeps working and is a warning; in `.chant/pipeline.ts` a
 * canary stage with no soak checks is refused by the spec check (EVL012).
 *
 * A member with a `.chant/pipeline.ts` promotes by its pipeline, whose own
 * check covers its canary, so the warning is for a member without one.
 * Run by `chant lint` over the project config, like the COMP checks, since
 * it reads the loaded config and not one source file.
 */

export const CANARY_WITHOUT_SOAK_CHECK_ID = "COR027";

/** What {@link canaryConfigDiagnostics} reads. */
export interface CanaryConfigInput {
  /** The member's `chant.config.ts`, for the diagnostic's file. */
  configPath: string;
  /** Its text, to point at the `canary` line; absent, the diagnostics point at line 1. */
  configText?: string;
  /** The loaded config's `environments`. */
  environments: readonly EnvironmentDeclaration[] | undefined;
  /** Whether the member has a `.chant/pipeline.ts`. */
  hasPipeline: boolean;
}

/** The line of the `n`-th `canary: true` in `text`, 1-based; 1 when there is none. */
function canaryLine(text: string | undefined, n: number): number {
  if (text === undefined) return 1;
  const lines = text.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const found = lines[i]!.match(/\bcanary\s*:\s*true\b/g)?.length ?? 0;
    if (seen + found > n) return i + 1;
    seen += found;
  }
  return 1;
}

/** One COR027 warning per `environments` entry marked canary, in a member with no pipeline. */
export function canaryConfigDiagnostics(input: CanaryConfigInput): LintDiagnostic[] {
  if (input.hasPipeline) return [];
  const canaries = (input.environments ?? []).filter((e): e is Exclude<EnvironmentDeclaration, string> => typeof e !== "string" && e.canary === true);
  return canaries.map((entry, n) => ({
    file: input.configPath,
    line: canaryLine(input.configText, n),
    column: 1,
    ruleId: CANARY_WITHOUT_SOAK_CHECK_ID,
    severity: "warning",
    message:
      `Environment "${entry.name}" is marked canary, and an environments entry has no soak checks, so the environments after it go on without waiting for it. ` +
      `Declare the stages in .chant/pipeline.ts, mark the stage canary and give it a soak with checks.`,
  }));
}
