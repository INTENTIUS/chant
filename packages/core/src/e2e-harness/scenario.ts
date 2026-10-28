/**
 * A scenario file (e2e-scenario/v1, chant#4587) and its lint. A scenario is
 * a repo tree, an ordered list of pull request steps, and the outcomes each
 * step must show. The lint refuses one that cannot record a row: no claim
 * id, no BREAK arm, nothing to check, or a step that names a pull request or
 * a merge no earlier step made. An await-pull step makes a pull request as
 * an open step does.
 */
import { readFileSync } from "node:fs";
import { validateScenario, type Scenario, type ScenarioStep } from "./schemas/index";

export interface ScenarioFinding {
  /** Where, as a JSON pointer into the file. */
  at: string;
  message: string;
}

/** Every reason `data` is not a scenario the driver can run and record. Empty when it is one. */
export function lintScenario(data: unknown): ScenarioFinding[] {
  const out: ScenarioFinding[] = [];
  const doc = (data ?? {}) as Partial<Scenario> & Record<string, unknown>;
  // The two refusals the protocol rests on, said plainly before the schema's wording.
  if (typeof doc.claim !== "string" || doc.claim.trim() === "") out.push({ at: "/claim", message: "the scenario has no claim id, so its run would record a row for nothing" });
  if (doc.break === undefined || doc.break === null) out.push({ at: "/break", message: "the scenario has no BREAK arm, so nothing shows its outcomes can fail" });
  else if ((doc.break as { env?: Record<string, string> }).env?.BREAK !== "1") out.push({ at: "/break/env/BREAK", message: 'the BREAK arm must set BREAK to "1"' });

  const v = validateScenario(data);
  if (!v.ok) {
    for (const e of v.errors) {
      const [at, ...rest] = e.split(" ");
      if ((at === "/" && /claim|break/.test(e)) || at!.startsWith("/break")) continue;
      out.push({ at: at!, message: rest.join(" ") });
    }
    return out;
  }
  const s = v.value;

  const seen = new Map<string, ScenarioStep>();
  let expectations = 0;
  s.steps.forEach((step, i) => {
    const at = `/steps/${i}`;
    if (seen.has(step.id)) out.push({ at: `${at}/id`, message: `step id ${step.id} is used twice` });
    const opened = (id: string) => {
      const o = seen.get(id);
      return o !== undefined && (o.do === "open" || o.do === "open-concurrent" || o.do === "await-pull");
    };
    switch (step.do) {
      case "open-concurrent": {
        const prev = s.steps[i - 1];
        if (!prev || (prev.do !== "open" && prev.do !== "open-concurrent")) {
          out.push({ at: `${at}/do`, message: "open-concurrent opens beside the step before it, which must be an open" });
        }
        break;
      }
      case "plan":
      case "approve":
      case "merge":
      case "comment":
        if (!opened(step.pull)) out.push({ at: `${at}/pull`, message: `${step.do} names ${step.pull}, which is not an earlier open or await-pull step` });
        break;
      case "apply": {
        const m = seen.get(step.merge);
        if (!m || m.do !== "merge") out.push({ at: `${at}/merge`, message: `apply names ${step.merge}, which is not an earlier merge step` });
        break;
      }
      default:
        break;
    }
    for (const [j, e] of (step.expect ?? []).entries()) {
      expectations++;
      if ("report" in e && step.do !== "plan" && step.do !== "apply") {
        out.push({ at: `${at}/expect/${j}`, message: `a report outcome belongs on a plan or apply step, not ${step.do}` });
      }
      const hasPull = "pull" in step || step.do === "open" || step.do === "open-concurrent" || step.do === "await-pull";
      if ("comment" in e && !hasPull) out.push({ at: `${at}/expect/${j}`, message: "a comment outcome belongs on a step with a pull request" });
      if ("pull" in e && !hasPull) out.push({ at: `${at}/expect/${j}`, message: "a pull outcome belongs on a step with a pull request" });
      if ("exit" in e && step.do !== "out-of-band") out.push({ at: `${at}/expect/${j}`, message: "an exit outcome belongs on an out-of-band step" });
    }
    seen.set(step.id, step);
  });
  if (expectations === 0) out.push({ at: "/steps", message: "no step expects anything, so the plain run would pass and the BREAK run could never be caught" });
  return out;
}

/** Read and lint a scenario file. Throws with every finding when it is not one. */
export function loadScenario(path: string): Scenario {
  const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const findings = lintScenario(data);
  if (findings.length > 0) throw new Error(`${path} is not a scenario the harness runs:\n${findings.map((f) => `  ${f.at}: ${f.message}`).join("\n")}`);
  return data as Scenario;
}
