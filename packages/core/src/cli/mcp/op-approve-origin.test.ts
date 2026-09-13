import { describe, test, expect, afterEach } from "vitest";
import { createOpApproveTool } from "./op-tools";
import { McpServer } from "./server";
import { readFileSync } from "node:fs";
import { resetGateOrigin, currentGateOrigin } from "../../lifecycle/gate-origin";

/**
 * chant#2384 — the MCP surface cannot both produce a gate and resolve it.
 *
 * `op-run` executes the Op in-process and returns the gate it stopped on;
 * `op-approve` then wrote the resolution with the approver taken from the
 * request. So the agent that produced a pending gate resolved it under any
 * name it liked, and #2300's plan binding did not close it: the digest comes
 * off the standing pending fact, which is the plan the same caller produced one
 * tool call earlier. The approval was for the right plan and meant nothing.
 *
 * These assert the two halves of the fix that are visible without a ledger: the
 * tool no longer offers a name it cannot verify, and constructing the server
 * declares the channel. The rule itself is exercised in
 * `../../lifecycle/gate-origin.test.ts`.
 */
describe("op-approve on the MCP channel (chant#2384)", () => {
  afterEach(() => resetGateOrigin());

  test("the tool no longer accepts a free-text approver", () => {
    const schema = createOpApproveTool().definition.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };

    // The hole, stated as a test: `approver` was free text on a channel that
    // cannot verify one, and the ledger recorded it indistinguishably from a
    // name a person gave. Recording "unattested" is more honest than recording
    // a name the model chose.
    expect(Object.keys(schema.properties)).not.toContain("approver");

    // The rest of the tool is unchanged — this narrows one field, it does not
    // remove the tool. The narrower alternative in the issue was to drop
    // op-approve entirely; this keeps it useful for the cross-channel case.
    expect(Object.keys(schema.properties).sort()).toEqual(["gate", "name", "note", "runtime", "url"]);
    expect(schema.required.sort()).toEqual(["gate", "name"]);
  });

  test("the description tells the caller where an approval has to come from", () => {
    // A model reads this string and nothing else. If it does not say that the
    // gate must be approved elsewhere, the model's only signal is a refusal it
    // cannot act on.
    const description = createOpApproveTool().definition.description;
    expect(description).toMatch(/refuses a gate this same channel reached/i);
    expect(description).toContain("chant approve");
    expect(description).toMatch(/unattested/i);
  });

  test("merely constructing a server does not change what the process is", () => {
    // Deliberate: the channel is declared in `start()`, not the constructor.
    // Building a server object in a test must not make every later gate fact in
    // that worker read as model-authored — which is exactly the contamination
    // the first version of this caused.
    new McpServer();
    expect(currentGateOrigin()).toBe("cli");
  });

  test("op-approve names its own channel, so it holds even on a server that never started", () => {
    // The ambient value covers the pending fact written during `op-run`. The
    // resolution does not rely on it: the tool passes `origin: "mcp"` outright,
    // so the rule holds regardless of what the process thinks it is.
    const source = readFileSync(new URL("./op-tools.ts", import.meta.url), "utf8");
    expect(source).toContain('origin: "mcp"');
  });
});
