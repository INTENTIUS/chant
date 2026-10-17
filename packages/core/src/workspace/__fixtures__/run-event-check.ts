/**
 * What every emitter's test checks about a run's stream (#4041): each line
 * passes `run-event.schema.json`, the stream opens with `run-start` and ends
 * with one `run-settle`, `seq` counts from 0, every line names the same run,
 * and every step that starts settles after its start, under the same step id.
 */

import { expect } from "vitest";
import { contract } from "./contract-repo";
import schema from "../run-event.schema.json";
import type { RunEvent } from "../../run-event";

const { expectValid } = contract(schema);

/** A step's id in the stream: its component, phase, name and place. */
export function stepKey(e: { component: string | null; phase: string; step: string; index?: number }): string {
  return JSON.stringify([e.component, e.phase, e.step, e.index ?? null]);
}

/** Check a stream's lines and hand back its events. */
export function checkRunEventLines(lines: string[]): RunEvent[] {
  for (const line of lines) expect(line.endsWith("\n")).toBe(true);
  const events = lines.map((l) => JSON.parse(l) as RunEvent);
  for (const event of events) expectValid(event);
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  expect(events[0]?.type).toBe("run-start");
  expect(events.at(-1)?.type).toBe("run-settle");
  expect(events.filter((e) => e.type === "run-settle")).toHaveLength(1);
  const runs = new Set(events.map((e) => JSON.stringify([e.runId, e.kind, e.name, e.gitSha, e.runtime, e.runOrigin])));
  expect(runs.size).toBe(1);

  const open = new Map<string, number>();
  for (const e of events) {
    if (e.type === "step-start") {
      const key = stepKey(e);
      expect(open.has(key), `${key} started twice`).toBe(false);
      open.set(key, e.seq);
    } else if (e.type === "step-settle") {
      const key = stepKey(e);
      if (open.has(key)) open.delete(key);
      // Only a step that never ran settles without a start.
      else expect(e.status, `${key} settled ${e.status} with no step-start`).toBe("skipped");
    }
  }
  expect([...open.keys()], "steps that started and never settled").toEqual([]);
  return events;
}

/** The step events of a stream, as `[type, step, status]`, for a compact assertion. */
export function stepTrail(events: RunEvent[]): Array<[string, string, string?]> {
  const out: Array<[string, string, string?]> = [];
  for (const e of events) {
    if (e.type === "step-start") out.push([e.type, e.step]);
    else if (e.type === "step-settle") out.push([e.type, e.step, e.skip ? `${e.status}:${e.skip}` : e.status]);
    else if (e.type === "gate-waiting" || e.type === "gate-resolved") out.push([e.type, e.step]);
  }
  return out;
}
