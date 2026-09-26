import { describe, expect, it } from "vitest";
import { fountainRun, resolveAgent, resolveAgentId } from "./fountain-run";
import type { FountainHttp } from "./fountain-apply";

describe("resolveAgent", () => {
  it("resolves by name and reports sandbox_mode from the search result", async () => {
    const http: FountainHttp = async (method, path) => {
      if (method === "GET" && path.startsWith("/api/agents?search=")) {
        return {
          status: 200,
          json: { data: [{ id: "agent-1", name: "researcher", sandbox_mode: "persistent" }] },
        };
      }
      throw new Error(`unrouted: ${method} ${path}`);
    };
    expect(await resolveAgent(http, "researcher")).toEqual({
      id: "agent-1",
      sandboxMode: "persistent",
    });
  });

  it("defaults sandbox_mode to ephemeral when the agent omits it", async () => {
    const http: FountainHttp = async () => ({
      status: 200,
      json: { data: [{ id: "agent-1", name: "researcher" }] },
    });
    expect(await resolveAgent(http, "researcher")).toEqual({
      id: "agent-1",
      sandboxMode: "ephemeral",
    });
  });

  it("looks a raw agent id up by GET /api/agents/{id} for its sandbox_mode", async () => {
    const calls: string[] = [];
    const http: FountainHttp = async (method, path) => {
      calls.push(`${method} ${path}`);
      return { status: 200, json: { data: { id: "123e4567-e89b-42d3-a456-426614174000", sandbox_mode: "persistent" } } };
    };
    const resolved = await resolveAgent(http, "123e4567-e89b-42d3-a456-426614174000");
    expect(resolved).toEqual({ id: "123e4567-e89b-42d3-a456-426614174000", sandboxMode: "persistent" });
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

describe("fountainRun — ephemeral (behaves as today, #2718)", () => {
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
      persistent: false,
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
      persistent: false,
      terminatedByDeadline: true,
    });
    expect(calls).toContain("POST /api/conversations/conv-2/terminate");
  });
});

describe("fountainRun — persistent (#2718)", () => {
  it("returns the finished turn's outcome once the conversation goes idle, without terminating", async () => {
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
    expect(result).toEqual({
      conversationId: "conv-3",
      status: "completed",
      persistent: true,
      terminatedByDeadline: false,
    });
    expect(calls).not.toContain("POST /api/conversations/conv-3/terminate");
  });

  it("reports a failed turn's outcome", async () => {
    const { http } = scriptedConversation({
      sandboxMode: "persistent",
      conversationId: "conv-4",
      statuses: ["running", "idle"],
      turns: [
        { turn_number: 1, status: "completed" },
        { turn_number: 2, status: "failed" },
      ],
    });

    const result = await fountainRun({ agent: "researcher", pollMs: 1, sleep: async () => {} }, undefined, http);
    expect(result.status).toBe("failed");
    expect(result.persistent).toBe(true);
  });

  it("does not terminate a hung run by default — the machine is a home (terminate: never)", async () => {
    const { http, calls } = scriptedConversation({
      sandboxMode: "persistent",
      conversationId: "conv-5",
      statuses: ["running"],
    });

    const result = await fountainRun(
      { agent: "researcher", timeoutMs: 1, pollMs: 1, sleep: async () => {} },
      undefined,
      http,
    );
    expect(result.terminatedByDeadline).toBe(true);
    expect(result.persistent).toBe(true);
    expect(calls).not.toContain("POST /api/conversations/conv-5/terminate");
  });

  it("terminate: on-deadline still ends a persistent agent's hung run", async () => {
    const { http, calls } = scriptedConversation({
      sandboxMode: "persistent",
      conversationId: "conv-6",
      statuses: ["running"],
    });

    await fountainRun(
      { agent: "researcher", terminate: "on-deadline", timeoutMs: 1, pollMs: 1, sleep: async () => {} },
      undefined,
      http,
    );
    expect(calls).toContain("POST /api/conversations/conv-6/terminate");
  });

  it("terminate: always ends the machine even after a clean turn", async () => {
    const { http, calls } = scriptedConversation({
      sandboxMode: "persistent",
      conversationId: "conv-7",
      statuses: ["running", "idle"],
      turns: [{ turn_number: 1, status: "completed" }],
    });

    const result = await fountainRun(
      { agent: "researcher", terminate: "always", pollMs: 1, sleep: async () => {} },
      undefined,
      http,
    );
    expect(result.terminatedByDeadline).toBe(false);
    expect(calls).toContain("POST /api/conversations/conv-7/terminate");
  });
});
