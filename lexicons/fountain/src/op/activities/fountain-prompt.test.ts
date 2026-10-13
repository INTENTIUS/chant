import { describe, expect, it } from "vitest";
import { fountainPrompt } from "./fountain-prompt";
import type { FountainHttp } from "./fountain-apply";

/** A conversation that takes one prompt and lists the turn it opens through `turns`, one reply per poll. */
function conversation(opts: { promptStatus?: number; promptJson?: unknown; turns: Array<Array<Record<string, unknown>>> }) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let poll = 0;
  let sentId: string | undefined;
  const http: FountainHttp = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === "POST" && path === "/api/conversations/conv-1/prompts") {
      bodies.push(body);
      sentId = (body as { client_request_id?: string }).client_request_id;
      return { status: opts.promptStatus ?? 200, json: opts.promptJson ?? { status: "queued", client_request_id: sentId } };
    }
    if (method === "GET" && path === "/api/conversations/conv-1/turns") {
      const page = opts.turns[Math.min(poll, opts.turns.length - 1)];
      poll += 1;
      return { status: 200, json: { data: page.map((t) => ({ client_request_id: sentId, ...t })) } };
    }
    if (method === "POST" && (path === "/api/conversations/conv-1/interrupt" || path === "/api/conversations/conv-1/terminate")) {
      return { status: 200, json: null };
    }
    throw new Error(`unrouted: ${method} ${path}`);
  };
  return { http, calls, bodies };
}

const quick = { pollMs: 1, sleep: async () => {} };
/** The build's own turn, which carries no client_request_id of ours. */
const build = { id: "t-1", turn_number: 1, status: "completed", client_request_id: null };

describe("fountainPrompt (#3356)", () => {
  it("sends the prompt to the conversation, finds its turn by client_request_id, and returns the turn's outcome", async () => {
    const { http, calls, bodies } = conversation({
      turns: [[build], [build, { id: "t-2", turn_number: 2, status: "running" }], [build, { id: "t-2", turn_number: 2, status: "completed" }]],
    });
    const result = await fountainPrompt({ conversation: "conv-1", prompt: "debrief", clientRequestId: "debrief-W-012", ...quick }, undefined, http);
    expect(bodies).toEqual([{ prompt: "debrief", client_request_id: "debrief-W-012" }]);
    expect(result).toEqual({
      conversationId: "conv-1",
      clientRequestId: "debrief-W-012",
      turnId: "t-2",
      turnNumber: 2,
      status: "completed",
      interruptedByDeadline: false,
      terminated: false,
    });
    expect(calls.filter((c) => c.endsWith("/terminate") || c.endsWith("/interrupt"))).toEqual([]);
  });

  it("names its own client_request_id when given none, and reports a service limit that ended the turn", async () => {
    const { http, bodies } = conversation({ turns: [[{ id: "t-2", turn_number: 2, status: "completed", limit_reason: "turn_deadline" }]] });
    const result = await fountainPrompt({ conversation: "conv-1", prompt: "debrief", ...quick }, undefined, http);
    const sent = (bodies[0] as { client_request_id: string }).client_request_id;
    expect(sent).toMatch(/^chant-[0-9a-f-]{36}$/);
    expect(result).toMatchObject({ clientRequestId: sent, status: "completed", limitReason: "turn_deadline" });
  });

  it("caps the turn by time: past timeoutMs it interrupts the turn and leaves the conversation up", async () => {
    const running = [{ id: "t-2", turn_number: 2, status: "running" }];
    // Polled at 0, 4 and 8 ms, running each time; read once more after the interrupt.
    const { http, calls } = conversation({ turns: [running, running, running, [{ id: "t-2", turn_number: 2, status: "interrupted" }]] });
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const result = await fountainPrompt({ conversation: "conv-1", prompt: "debrief", timeoutMs: 10, pollMs: 4, sleep: async (ms) => void (now += ms) }, undefined, http);
      expect(result).toMatchObject({ status: "interrupted", interruptedByDeadline: true, terminated: false, turnId: "t-2" });
    } finally {
      Date.now = realNow;
    }
    expect(calls).toContain("POST /api/conversations/conv-1/interrupt");
    expect(calls).not.toContain("POST /api/conversations/conv-1/terminate");
  });

  it("terminates the conversation after the turn when asked, and only on the deadline with on-deadline", async () => {
    const always = conversation({ turns: [[{ id: "t-2", turn_number: 2, status: "completed" }]] });
    expect(await fountainPrompt({ conversation: "conv-1", prompt: "debrief", terminate: "always", ...quick }, undefined, always.http)).toMatchObject({ terminated: true });
    expect(always.calls.at(-1)).toBe("POST /api/conversations/conv-1/terminate");
    const onDeadline = conversation({ turns: [[{ id: "t-2", turn_number: 2, status: "failed" }]] });
    expect(await fountainPrompt({ conversation: "conv-1", prompt: "debrief", terminate: "on-deadline", ...quick }, undefined, onDeadline.http)).toMatchObject({ status: "failed", terminated: false });
  });

  it("says precisely why fountain refused the turn: a terminated conversation, a busy one, an unknown one", async () => {
    const terminated = conversation({ promptStatus: 410, promptJson: { error: "conversation_terminal" }, turns: [[]] });
    await expect(fountainPrompt({ conversation: "conv-1", prompt: "debrief", ...quick }, undefined, terminated.http)).rejects.toThrow(
      /conv-1 is terminated, and fountain adds no turn to a terminated conversation/,
    );
    const busy = conversation({ promptStatus: 400, turns: [[]] });
    await expect(fountainPrompt({ conversation: "conv-1", prompt: "debrief", ...quick }, undefined, busy.http)).rejects.toThrow(/busy: a turn is running/);
    const missing = conversation({ promptStatus: 404, turns: [[]] });
    await expect(fountainPrompt({ conversation: "conv-1", prompt: "debrief", ...quick }, undefined, missing.http)).rejects.toThrow(/no conversation conv-1/);
  });

  it("refuses a missing conversation id or an empty prompt before calling fountain", async () => {
    const http: FountainHttp = async () => {
      throw new Error("should not be called");
    };
    await expect(fountainPrompt({ conversation: "", prompt: "hi" }, undefined, http)).rejects.toThrow(/conversation's id/);
    await expect(fountainPrompt({ conversation: "conv-1", prompt: "  " }, undefined, http)).rejects.toThrow(/prompt with words/);
  });

  it("on abort it interrupts the turn, applies the terminate policy, and fails with the abort's reason", async () => {
    const { http, calls } = conversation({ turns: [[{ id: "t-2", turn_number: 2, status: "running" }]] });
    const abort = new AbortController();
    const run = fountainPrompt(
      { conversation: "conv-1", prompt: "debrief", terminate: "on-deadline", pollMs: 1, sleep: async () => abort.abort(new Error("lease-lost")) },
      abort.signal,
      http,
    );
    await expect(run).rejects.toThrow(/lease-lost/);
    expect(calls.slice(-2)).toEqual(["POST /api/conversations/conv-1/interrupt", "POST /api/conversations/conv-1/terminate"]);
  });
});
