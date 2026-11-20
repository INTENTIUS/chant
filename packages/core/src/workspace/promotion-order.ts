/**
 * A member's promotion order (#4030): the literal entries of the `environments`
 * array in its `chant.config.ts`, in the order written. A release moves from
 * each environment to the next, so `chant components promote --to <env>` can
 * default `--from` to the step before, and `chant workspace status --json`
 * lists the order for a reader such as behold's lane.
 *
 * A pattern entry such as `pr-*` names no environment, so it is not a step.
 * A component's own `environments` (`component.schema.json`) say where its
 * release is hosted in each environment and never set the order.
 *
 * `canary` marks a step as the canary step. An `environments` entry has no
 * soak to hold the steps after it, so `chant lint` warns on one (COR027).
 * In a pipeline (`../pipeline/stages.ts`), the canary stage's soak holds
 * every stage after it (#5327), and the step carries that stage's mark.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { environmentName, isEnvironmentPattern, type EnvironmentDeclaration } from "../config";

/** One step of a member's promotion order. */
export interface PromotionStep {
  name: string;
  /** True when the entry sets `canary: true`. */
  canary: boolean;
  /**
   * A pipeline stage's hold or freeze window now (#5354): until when (null
   * when only a change to the pipeline lifts it), why, and what the person
   * who lifts it reads first. Absent when the stage is open.
   */
  held?: { kind: "hold" | "freeze"; until: string | null; reason?: string; description?: string };
}

/** The member's promotion order from its config's `environments`; `[]` when it declares none. A repeated name keeps its first place. */
export function promotionOrder(declared: readonly EnvironmentDeclaration[] | null | undefined): PromotionStep[] {
  const out: PromotionStep[] = [];
  for (const entry of declared ?? []) {
    const name = environmentName(entry);
    if (isEnvironmentPattern(name) || out.some((s) => s.name === name)) continue;
    out.push({ name, canary: typeof entry !== "string" && entry.canary === true });
  }
  return out;
}

const STRING = String.raw`(?:"[^"\\\n\[\]{}]*"|'[^'\\\n\[\]{}]*')`;
const PROP = String.raw`(?:(?:name|endpoint)\s*:\s*${STRING}|canary\s*:\s*(?:true|false))`;
const ENTRY = String.raw`(?:${STRING}|\{\s*(?:${PROP}\s*,?\s*)*\})`;
const ARRAY = new RegExp(String.raw`^\[\s*(?:${ENTRY}\s*,?\s*)*\]$`);

/**
 * The promotion order a `chant.config.ts` writes as literals, read from its
 * text without running it, or `undefined` when the text is not that simple.
 * Evaluating a TypeScript config loads tsx, and `workspace status` reads every
 * member without that cost (#3976), so the plain cases are read here and the
 * rest fall back to loading the config. The plain cases are a config with no
 * `environments` and no spread, and one whose only `environments` is an array
 * of string entries and `{ name, endpoint, canary }` entries with literal values.
 */
export function staticPromotionOrder(source: string): PromotionStep[] | undefined {
  const text = source.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "$1");
  const mentions = text.match(/\benvironments\b/g)?.length ?? 0;
  if (mentions === 0) return /export\s+default\s*\{/.test(text) && !text.includes("...") ? [] : undefined;
  if (mentions > 1 || text.includes("...")) return undefined;
  const start = text.match(/\benvironments\s*:\s*(\[)/);
  if (!start || start.index === undefined) return undefined;
  const open = start.index + start[0].length - 1;
  const close = text.indexOf("]", open);
  if (close < 0) return undefined;
  const array = text.slice(open, close + 1);
  if (!ARRAY.test(array)) return undefined;
  const entries: EnvironmentDeclaration[] = [];
  for (const m of array.matchAll(new RegExp(`${STRING}|\\{[^}]*\\}`, "g"))) {
    const raw = m[0];
    if (raw.startsWith("{")) {
      const name = raw.match(/\bname\s*:\s*(?:"([^"]*)"|'([^']*)')/);
      if (!name) return undefined;
      entries.push({ name: name[1] ?? name[2], canary: /\bcanary\s*:\s*true\b/.test(raw) });
    } else {
      entries.push(raw.slice(1, -1));
    }
  }
  return promotionOrder(entries);
}

/**
 * One member's promotion order: the stages of its `.chant/pipeline.ts` when
 * it has one (#5324), else its config's `environments`. `[]` when it has
 * none or declares no environments, and null when the config can't be read
 * or the pipeline does not fold.
 * A TypeScript config is read as text when it is plain ({@link staticPromotionOrder}),
 * and loaded otherwise.
 */
export async function readMemberPromotionOrder(dir: string): Promise<PromotionStep[] | null> {
  try {
    // #5324: a member with a pipeline takes its order from the folded stages; one that does not fold has none to read.
    // The fold loads the TypeScript compiler, so it is imported only for a member that has the file.
    if (existsSync(join(dir, ".chant", "pipeline.ts"))) {
      const { readMemberPipeline } = await import("../pipeline/read");
      const pipeline = readMemberPipeline(dir);
      if (pipeline.status === "folded") {
        // #5354: a held stage says so, with what the person who lifts the hold reads first.
        const { stageHeldAt } = await import("../pipeline/stages");
        const now = new Date();
        return pipeline.spec.stages.map((s) => {
          const held = stageHeldAt(s, now);
          const { stage: _stage, ...rest } = held ?? { stage: "" };
          return { name: s.name, canary: s.canary === true, ...(held ? { held: rest as NonNullable<PromotionStep["held"]> } : {}) };
        });
      }
      if (pipeline.status === "refused") return null;
    }
    const ts = join(dir, "chant.config.ts");
    if (existsSync(ts)) {
      const plain = staticPromotionOrder(readFileSync(ts, "utf-8"));
      if (plain) return plain;
    }
    const { loadChantConfig } = await import("../config");
    const { config } = await loadChantConfig(dir);
    return promotionOrder(config.environments);
  } catch {
    return null;
  }
}
