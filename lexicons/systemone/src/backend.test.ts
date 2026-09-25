import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { postQuestion, questionName, systemoneAsk } from "./backend";
import { requestProblem, startStubBackend, type StubBackend } from "./stub-backend";

let stub: StubBackend;
beforeAll(async () => {
  stub = await startStubBackend({ model: "jev-1.13.0" });
});
afterAll(() => stub.close());

const request = { point: "slice-tier", backend: "local", model: "jev-1.13.0", question: { type: "choice" as const, instructions: "Pick", criteria: { small: "s", large: "l" } }, state: { size: 3 } };

describe("the wire-format client", () => {
  test("a point's name is the question's name, as points ask --response reads it", () => {
    expect(questionName("slice-tier")).toBe("slice-tier");
  });

  test("posts to /v1/systemone and reads the answer back by the question's name", async () => {
    const r = await postQuestion({ url: `${stub.url}/` }, "local", request, { cwd: process.cwd() });
    expect(r.model).toBe("jev-1.13.0");
    expect(r.answer).toMatchObject({ type: "choice", choice: "small" });
    expect(Object.keys(stub.requests[stub.requests.length - 1].questions)).toEqual(["slice-tier"]);
  });

  test("a name no backend has, and a timeout, throw", async () => {
    await expect(systemoneAsk({ backends: {}, cwd: process.cwd() })(request)).rejects.toThrow("no backend named local is configured");
    const hang = (_url: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(postQuestion({ url: "http://127.0.0.1:9", timeoutMs: 20 }, "local", request, { cwd: process.cwd(), transport: hang as never })).rejects.toThrow("no answer within 20 ms");
  });

  test("a response without the answer, or not JSON, throws", async () => {
    const fake = (body: string) => (async () => new Response(body, { status: 200 })) as never;
    await expect(postQuestion({ url: "http://x" }, "b", request, { cwd: process.cwd(), transport: fake('{"model":"jev-1.13.0","answers":{}}') })).rejects.toThrow("has no answer to slice-tier");
    await expect(postQuestion({ url: "http://x" }, "b", request, { cwd: process.cwd(), transport: fake("<html>") })).rejects.toThrow("not JSON");
  });
});

describe("the stub", () => {
  test("refuses a request outside the wire format with 422", async () => {
    expect(requestProblem({ model: "m", state: {}, questions: { q: { type: "score", instructions: "i", criteria: ["one"] } } })).toContain("2 to 10 levels");
    const res = await fetch(`${stub.url}/v1/systemone`, { method: "POST", body: JSON.stringify({ model: "m" }) });
    expect(res.status).toBe(422);
  });
});
