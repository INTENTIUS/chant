/**
 * Reaching a gate that asks a declared decision point (#3170). The shape of
 * the declaration is in `./gate-point.ts`.
 *
 * The run asks the point with the gate's own `gate.*` inputs (those the point
 * declares) and the authored ones, through the `decide` activity's path
 * (`./activities/decide.ts`), so the chain, the model's threshold, the reuse
 * of an answer the same inputs already have and the escalation to people are
 * the decide activity's. Then:
 *
 * - The question is open (escalated to people, or a model's proposal waiting
 *   for a person): the run records a pending fact on the gate ledger that
 *   cites the question, as a plain gate records one, and ends `waiting` on
 *   the question. A person answers it with `chant workspace points answer
 *   <id>` (or through hud), and the next run, or the local operator's next
 *   round, asks again and finds the answer.
 * - It is answered with an answer the gate passes on (`pass`, default yes):
 *   the run appends a resolution to the gate ledger that cites the answer
 *   record, once per answer and plan, and walks through.
 * - It is answered otherwise: the gate step fails, naming the record. `points
 *   retract` takes the answer back and asks people again.
 *
 * `chant approve` does not pass such a gate: only the point's answer does.
 * The answer record names the gate in its `constrains` (`gate:<op>/<gate>`)
 * and, when the point declares them, in its `gate.*` inputs.
 */

import { defaultGatePointStore, gatePointInputs } from "./gate-point";
import { isPointWait } from "./steward-points";
import type { GatePointAsker } from "../point-decision";

// The decision itself bundles without the workspace (#3816): `@intentius/chant/point-decision`.
export {
  evaluatePointGate,
  pointGateResumable,
  type GatePointAsker,
  type PointQuestionState,
  type PointResumeCheck,
  type GatePointQuestion,
  type GatePointRequest,
  type PointGateCheck,
  type PointGateInput,
  type PointGateLedgerPort,
} from "../point-decision";

/**
 * The real asker: the workspace that holds `cwd`. It reads the point's
 * declared inputs from `points`, adds the `gate.*` ones the point declares,
 * and asks through the decide activity. A point with no model decider is
 * asked with no backends, so the run needs no `decide.backends`. A question
 * goes where the gate's `point.store` says, and to the ledger in a CI job
 * when it says nothing (`defaultGatePointStore`, #3815).
 */
export function workspaceGatePointAsker(cwd: string): GatePointAsker {
  return {
    async ask(request) {
      const { workspacePoints } = await import("../workspace/points-cli");
      const doc = await workspacePoints({ cwd });
      if ("error" in doc) throw new Error(`decision point ${request.point}: ${doc.error.code}: ${doc.error.message}`);
      const point = doc.points.find((p) => p.name === request.point);
      if (!point) {
        const bad = doc.sources.find((s) => s.reason);
        throw new Error(`gate "${request.facts.name}" asks decision point ${request.point}, and no points file declares it${bad ? ` (${bad.kind}: ${bad.reason!.message})` : ""}`);
      }
      const inputs = gatePointInputs(request.point, point.inputs.map((i) => i.name), request.facts, request.inputs);
      const { runDecide } = await import("./activities/decide");
      const asksModel = point.deciders.some((d) => d.kind === "model");
      try {
        const store = request.store ?? defaultGatePointStore();
        const r = await runDecide({ point: request.point, inputs, subject: request.subject, cwd, ...(store ? { store } : {}), ...(asksModel ? {} : { backends: {} }) });
        return { id: r.id, point: request.point, path: r.path, state: r.state, answer: r.answer, decider: r.decider, answeredBy: r.answeredBy, subject: request.subject, steward: null };
      } catch (err) {
        if (!isPointWait(err)) throw err;
        const q = err.question;
        return { id: q.id, point: q.point, path: q.path, state: q.state, answer: null, decider: "quorum", answeredBy: [], subject: q.subject, steward: q.steward };
      }
    },
  };
}
