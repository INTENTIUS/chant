/**
 * The decide activity against a real Jev-compatible server (#2740). Gated:
 * it runs only when TYPESAFE_API_KEY is set, and is skipped otherwise, so the
 * suite never needs an account or the network.
 *
 *   TYPESAFE_API_KEY=... npx vitest run packages/core/src/op/activities/decide.live.test.ts
 *
 * TYPESAFE_BASE_URL points it at another compatible server (the default is
 * https://api.typesafe.ai), and TYPESAFE_MODEL at another pinned model id (the
 * default is jev-1.13.0). A model id is always a versioned one, never an alias.
 */

import { afterAll, describe, expect, test } from "vitest";
import { isPointWait } from "../steward-points";
import { workspacePoints } from "../../workspace/points-cli";
import { postQuestion } from "../decide-backend";
import { cleanScratch, workspace } from "../../workspace/__fixtures__/decide-workspace";
import { runDecide } from "./decide";

const key = process.env.TYPESAFE_API_KEY;
const url = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai";
const model = process.env.TYPESAFE_MODEL ?? "jev-1.13.0";
const backend = { url, key: { env: "TYPESAFE_API_KEY" }, timeoutMs: 60_000 };

afterAll(cleanScratch);

describe.skipIf(!key)("decide against a real Jev-compatible server (TYPESAFE_API_KEY is set)", () => {
  test("the server answers each question type in the wire format", async () => {
    const cwd = process.cwd();
    const noul = await postQuestion(backend, "systemone", {
      point: "live-noul",
      backend: "systemone",
      model,
      question: { type: "noul", instructions: "Is the sky in the state blue?", criteria: { true: "It is blue.", false: "It is not blue." } },
      state: { sky: "a clear blue sky at noon" },
    }, { cwd });
    expect(noul.model).toBe(model);
    expect(noul.answer.type).toBe("noul");
    expect((noul.answer as { noul: number }).noul).toBeGreaterThanOrEqual(0);

    const choice = await postQuestion(backend, "systemone", {
      point: "live-choice",
      backend: "systemone",
      model,
      question: { type: "choice", instructions: "Which team takes the ticket in the state?", criteria: { billing: "Payments and invoices.", platform: "Servers and deploys." } },
      state: { ticket: "The production deploy failed with a disk full error." },
    }, { cwd });
    expect(choice.answer).toMatchObject({ type: "choice" });
    expect(["billing", "platform"]).toContain((choice.answer as { choice: string }).choice);

    const score = await postQuestion(backend, "systemone", {
      point: "live-score",
      backend: "systemone",
      model,
      question: { type: "score", instructions: "How urgent is the ticket in the state?", criteria: ["not urgent", "somewhat urgent", "very urgent"] },
      state: { ticket: "Every customer is locked out of their account." },
    }, { cwd });
    expect(score.answer).toMatchObject({ type: "score" });
  }, 120_000);

  test("the activity asks a point and records the model's answer or its escalation", async () => {
    const root = workspace();
    const outcome = await runDecide({ cwd: root, point: "triage", inputs: { "record.size": 5, "record.risky": true }, backends: { systemone: backend } }, {}).then(
      (r) => r.id,
      (e: unknown) => {
        if (isPointWait(e)) return e.question.id;
        throw e;
      },
    );
    const doc = await workspacePoints({ cwd: root });
    if ("error" in doc) throw new Error(doc.error.message);
    const q = doc.questions.find((x) => x.id === outcome)!;
    // The server answered: a proposal at the pin, or an escalation below the threshold with the model's lean. Never unreachable.
    expect(["proposed", "escalated"]).toContain(q.state);
    if (q.state === "proposed") expect(q.decider).toMatchObject({ kind: "model", model });
    else expect(q.escalations.find((e) => e.kind === "model")?.reason).not.toContain("could not answer");
  }, 120_000);
});
