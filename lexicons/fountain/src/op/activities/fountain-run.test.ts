import { describe, expect, it } from "vitest";
import { fountainRun, resolveAgent, resolveAgentId } from "./fountain-run";
import type { FountainHttp } from "./fountain-apply";

describe("resolveAgent", () => {
  it("resolves by name from the search result", async () => {
    const http: FountainHttp = async (method, path) => {
      if (method === "GET" && path.startsWith("/api/agents?search=")) {
        return {
          status: 200,
          json: { data: [{ id: "agent-1", name: "researcher", sandbox_mode: "persistent" }] },
        };
      }
      throw new Error(`unrouted: ${method} ${path}`);
    };
    expect(await resolveAgent(http, "researcher")).toEqual({ id: "agent-1" });
  });

  it("looks a raw agent id up by GET /api/agents/{id}", async () => {
    const calls: string[] = [];
    const http: FountainHttp = async (method, path) => {
      calls.push(`${method} ${path}`);
      return { status: 200, json: { data: { id: "123e4567-e89b-42d3-a456-426614174000" } } };
    };
    const resolved = await resolveAgent(http, "123e4567-e89b-42d3-a456-426614174000");
    expect(resolved).toEqual({ id: "123e4567-e89b-42d3-a456-426614174000" });
    expect(calls).toEqual(["GET /api/agents/123e4567-e89b-42d3-a456-426614174000"]);
  });
});

describe("resolveAgentId", () => {
  it("returns a raw agent id with no HTTP call", async () => {
    const http: FountainHttp = async () => {
      throw new Error("should not be called");
    };
    expect(await resolveAgentId(http, "123e4567-e89b-42d3-a456-426614174000")).toBe(
      "123e4567-e89b-42d3-a456-426614174000",
    );
  });
});

/** A scripted conversation: agent lookup, create, then a fixed sequence of GET replies. */
function scriptedConversation(opts: {
  sandboxMode?: string;
  conversationId: string;
  statuses: string[];
  turns?: Array<{ turn_number: number; status: string }>;
}) {
  const calls: string[] = [];
  let statusIndex = 0;
  const http: FountainHttp = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === "GET" && path.startsWith("/api/agents?search=")) {
      return {
        status: 200,
        json: {
          data: [{ id: "agent-1", name: "researcher", sandbox_mode: opts.sandboxMode }],
        },
      };
    }
    if (method === "POST" && path === "/api/conversations") {
      expect((body as Record<string, unknown>).agent_id).toBe("agent-1");
      return { status: 201, json: { data: { id: opts.conversationId } } };
    }
    if (method === "GET" && path === `/api/conversations/${opts.conversationId}`) {
      const status = opts.statuses[Math.min(statusIndex, opts.statuses.length - 1)];
      statusIndex += 1;
      return { status: 200, json: { data: { status } } };
    }
    if (method === "GET" && path === `/api/conversations/${opts.conversationId}/turns`) {
      return { status: 200, json: { data: opts.turns ?? [] } };
    }
    if (method === "POST" && path === `/api/conversations/${opts.conversationId}/terminate`) {
      return { status: 200, json: null };
    }
    throw new Error(`unrouted: ${method} ${path}`);
  };
  return { http, calls };
}

describe("fountainRun (#2718, #3386)", () => {
  it("resolves the agent by name, starts, and polls to a terminal status", async () => {
    const { http } = scriptedConversation({
      sandboxMode: "ephemeral",
      conversationId: "conv-1",
      statuses: ["running", "running", "completed"],
    });

    const result = await fountainRun(
      { agent: "researcher", prompt: "hi", pollMs: 1, sleep: async () => {} },
      undefined,
      http,
    );
    expect(result).toEqual({
      conversationId: "conv-1",
      status: "completed",
      terminatedByDeadline: false,
    });
  });

  it("terminates the conversation when the deadline passes", async () => {
    const { http, calls } = scriptedConversation({
      sandboxMode: "ephemeral",
      conversationId: "conv-2",
      statuses: ["running"],
    });

    const result = await fountainRun(
      { agent: "researcher", timeoutMs: 1, pollMs: 1, sleep: async () => {} },
      undefined,
      http,
    );
    expect(result).toEqual({
      conversationId: "conv-2",
      status: "terminated",
      terminatedByDeadline: true,
    });
    expect(calls).toContain("POST /api/conversations/conv-2/terminate");
  });

  it("ends on idle with the latest turn's outcome, and terminates the machine by default (#3386)", async () => {
    const { http, calls } = scriptedConversation({
      sandboxMode: "ephemeral",
      conversationId: "conv-e1",
      statuses: ["pending", "running", "idle"],
      turns: [{ turn_number: 1, status: "completed" }],
    });

    const result = await fountainRun(
      { agent: "researcher", prompt: "hi", timeoutMs: 60_000, pollMs: 1, sleep: async () => {} },
      undefined,
      http,
    );
    expect(result).toEqual({
      conversationId: "conv-e1",
      status: "completed",
      terminatedByDeadline: false,
    });
    expect(calls.filter((c) => c === "GET /api/conversations/conv-e1")).toHaveLength(3);
    expect(calls).toContain("POST /api/conversations/conv-e1/terminate");
  });

  it("reports a failed or interrupted turn as the run's outcome (#3386)", async () => {
    for (const turnStatus of ["failed", "interrupted"]) {
      const { http } = scriptedConversation({
        sandboxMode: "ephemeral",
        conversationId: "conv-e2",
        statuses: ["running", "idle"],
        turns: [{ turn_number: 1, status: turnStatus }],
      });
      const result = await fountainRun({ agent: "researcher", prompt: "hi", pollMs: 1, sleep: async () => {} }, undefined, http);
      expect(result.status).toBe(turnStatus);
      expect(result.terminatedByDeadline).toBe(false);
    }
  });

  it("keeps polling an idle conversation whose latest turn has not ended (#3386)", async () => {
    const { http, calls } = scriptedConversation({
      sandboxMode: "ephemeral",
      conversationId: "conv-e3",
      statuses: ["idle"],
      turns: [{ turn_number: 1, status: "running" }],
    });
    let sleeps = 0;
    const result = await fountainRun(
      {
        agent: "researcher",
        prompt: "hi",
        timeoutMs: 50,
        pollMs: 1,
        sleep: async () => {
          sleeps += 1;
          await new Promise((r) => setTimeout(r, 5));
        },
      },
      undefined,
      http,
    );
    expect(sleeps).toBeGreaterThan(1);
    expect(result.status).toBe("terminated");
    expect(result.terminatedByDeadline).toBe(true);
    expect(calls).toContain("POST /api/conversations/conv-e3/terminate");
  });

  it("terminate: never leaves a finished conversation up for a later fountainPrompt turn", async () => {
    const { http, calls } = scriptedConversation({
      sandboxMode: "ephemeral",
      conversationId: "conv-e4",
      statuses: ["running", "idle"],
      turns: [{ turn_number: 1, status: "completed" }],
    });
    const result = await fountainRun(
      { agent: "researcher", prompt: "hi", terminate: "never", pollMs: 1, sleep: async () => {} },
      undefined,
      http,
    );
    expect(result.status).toBe("completed");
    expect(calls).not.toContain("POST /api/conversations/conv-e4/terminate");
  });
});

describe("fountainRun — an agent row that still reads persistent (managoat/managoat#2793)", () => {
  it("runs it as the server does, ephemeral: ends on the turn and terminates by default", async () => {
    const { http, calls } = scriptedConversation({
      sandboxMode: "persistent",
      conversationId: "conv-3",
      statuses: ["pending", "running", "idle"],
      turns: [{ turn_number: 1, status: "completed" }],
    });

    const result = await fountainRun(
      { agent: "researcher", prompt: "hi", pollMs: 1, sleep: async () => {} },
      undefined,
      http,
    );
    expect(result).toEqual({ conversationId: "conv-3", status: "completed", terminatedByDeadline: false });
    expect(calls).toContain("POST /api/conversations/conv-3/terminate");
  });

  it("terminate: on-deadline leaves a cleanly finished run up", async () => {
    const { http, calls } = scriptedConversation({
      sandboxMode: "ephemeral",
      conversationId: "conv-6",
      statuses: ["running", "idle"],
      turns: [{ turn_number: 1, status: "completed" }],
    });

    await fountainRun(
      { agent: "researcher", terminate: "on-deadline", prompt: "hi", pollMs: 1, sleep: async () => {} },
      undefined,
      http,
    );
    expect(calls).not.toContain("POST /api/conversations/conv-6/terminate");
  });
});

describe("fountainRun — the conversation's machine", () => {
  it("reports the sandbox and its machine name, and passes spriteName through as sprite_name", async () => {
    const bodies: unknown[] = [];
    let polls = 0;
    const http: FountainHttp = async (method, path, body) => {
      if (method === "GET" && path.startsWith("/api/agents?search=")) {
        return { status: 200, json: { data: [{ id: "agent-1", name: "box" }] } };
      }
      if (method === "POST" && path === "/api/conversations") {
        bodies.push(body);
        return { status: 201, json: { data: { id: "conv-1", status: "pending", sandbox_id: "sbx-1" } } };
      }
      if (method === "GET" && path === "/api/conversations/conv-1") {
        polls += 1;
        return {
          status: 200,
          json: {
            data: {
              status: polls < 2 ? "running" : "idle",
              sandbox: { id: "sbx-1", sprite_name: "fountain-abc-studio-box", status: "ready" },
            },
          },
        };
      }
      if (method === "GET" && path === "/api/conversations/conv-1/turns") {
        return { status: 200, json: { data: [{ turn_number: 1, status: "completed" }] } };
      }
      if (method === "POST" && path === "/api/conversations/conv-1/terminate") return { status: 200, json: null };
      throw new Error(`unrouted: ${method} ${path}`);
    };

    const result = await fountainRun(
      { agent: "box", prompt: "hi", spriteName: "studio-box", pollMs: 1, sleep: async () => {} },
      undefined,
      http,
    );
    expect(result).toEqual({
      conversationId: "conv-1",
      status: "completed",
      terminatedByDeadline: false,
      sandboxId: "sbx-1",
      spriteName: "fountain-abc-studio-box",
    });
    expect(bodies[0]).toEqual({ agent_id: "agent-1", prompt: "hi", sprite_name: "studio-box" });
  });
});

describe("fountainRun — sandboxApiAccess (#2780)", () => {
  it("passes sandbox_api_access through on an ephemeral agent", async () => {
    const bodies: unknown[] = [];
    const { http: inner } = scriptedConversation({ sandboxMode: "ephemeral", conversationId: "conv-1", statuses: ["completed"] });
    const http: FountainHttp = async (method, path, body) => {
      if (method === "POST" && path === "/api/conversations") bodies.push(body);
      return inner(method, path, body);
    };
    await fountainRun({ agent: "researcher", prompt: "hi", sandboxApiAccess: "none", pollMs: 1, sleep: async () => {} }, undefined, http);
    expect(bodies).toEqual([{ agent_id: "agent-1", prompt: "hi", sandbox_api_access: "none" }]);
  });
});
