/**
 * `--report-url` (#4007): the URL forms, the key, and the upload of a run's
 * events as it goes: one upload in flight at a time, a failure that warns
 * and never stops the run, and a last upload that carries everything. The
 * s3 scheme runs a fake AWS CLI; nothing here reaches a network.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openPrReportUpload, parseReportUrl, reportKey, reportPut, type ReportPut } from "./pr-report-url";

const line = (type: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ type, ...extra }) + "\n";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-report-url-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseReportUrl", () => {
  test("reads s3 and file URLs and refuses anything else", () => {
    expect(parseReportUrl("s3://bucket/a/b/")).toEqual({ scheme: "s3", url: "s3://bucket/a/b", bucket: "bucket", prefix: "a/b" });
    expect(parseReportUrl("s3://bucket")).toEqual({ scheme: "s3", url: "s3://bucket", bucket: "bucket", prefix: "" });
    expect(parseReportUrl(pathToFileURL(dir).href)).toMatchObject({ scheme: "file", dir });
    expect(parseReportUrl("https://example.invalid/x")).toHaveProperty("error");
  });

  test("keys by pull request and commit, and by member after them", () => {
    expect(reportKey(12, "abc")).toBe("12/abc");
    expect(reportKey(null, "abc")).toBe("unknown/abc");
    expect(reportKey(12, "abc", "api")).toBe("12/abc/api");
  });
});

describe("openPrReportUpload", () => {
  /** A put whose uploads finish only when the test says, recording what each carried. */
  function heldPut() {
    const calls: Array<{ key: string; body: string; finish: (err?: Error) => void }> = [];
    let inFlight = 0;
    let most = 0;
    const put: ReportPut = (key, body) =>
      new Promise<void>((resolve, reject) => {
        inFlight++;
        most = Math.max(most, inFlight);
        calls.push({ key, body, finish: (err) => { inFlight--; if (err) reject(err); else resolve(); } });
      });
    return { put, calls, most: () => most };
  }

  test("uploads the events on each settle, never two at once, and the settles that came meanwhile in one more", async () => {
    const held = heldPut();
    const upload = openPrReportUpload({ target: { scheme: "s3", url: "s3://b", bucket: "b", prefix: "" }, key: "12/abc", stage: "apply", warn: () => {}, put: held.put });
    upload.line(line("run-start"));
    expect(held.calls).toHaveLength(0);
    upload.line(line("wave-start", { wave: 1 }));
    upload.line(line("component-settle", { wave: 1 }));
    expect(held.calls).toHaveLength(1);
    upload.line(line("wave-settle", { wave: 1 }));
    upload.line(line("wave-start", { wave: 2 }));
    upload.line(line("component-settle", { wave: 2 }));
    // Both settles wait behind the one in flight, and go up as one.
    expect(held.calls).toHaveLength(1);
    held.calls[0]!.finish();
    await new Promise((r) => setImmediate(r));
    expect(held.calls).toHaveLength(2);
    expect(held.calls[1]!.body.split("\n").filter(Boolean)).toHaveLength(6);
    expect(held.calls[1]!.key).toBe("12/abc/pr-apply.events.jsonl");

    upload.file("pr-apply.json", "{}\n");
    const closing = upload.close();
    await new Promise((r) => setImmediate(r));
    // The last upload waits for the one in flight.
    expect(held.calls).toHaveLength(2);
    held.calls[1]!.finish();
    await new Promise((r) => setImmediate(r));
    held.calls[2]!.finish();
    await new Promise((r) => setImmediate(r));
    held.calls[3]!.finish();
    await closing;
    expect(held.calls.map((c) => c.key)).toEqual(["12/abc/pr-apply.events.jsonl", "12/abc/pr-apply.events.jsonl", "12/abc/pr-apply.events.jsonl", "12/abc/pr-apply.json"]);
    expect(held.most()).toBe(1);
  });

  test("a failed upload as the run goes warns once and the run goes on; the last one is tried again", async () => {
    const warnings: string[] = [];
    let fail = true;
    const put: ReportPut = async (key) => {
      if (fail) throw new Error(`no bucket for ${key}`);
    };
    const upload = openPrReportUpload({ target: { scheme: "s3", url: "s3://b", bucket: "b", prefix: "" }, key: "12/abc", stage: "apply", warn: (m) => warnings.push(m), put });
    upload.line(line("component-settle"));
    await new Promise((r) => setImmediate(r));
    upload.line(line("wave-settle"));
    await new Promise((r) => setImmediate(r));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/as the run went: no bucket .*The run goes on/);
    fail = false;
    await upload.close();
    expect(warnings).toHaveLength(1);
  });

  test("file://: each settle replaces the events file whole, so it holds a wave's settle before the next wave starts", async () => {
    const target = parseReportUrl(pathToFileURL(dir).href);
    if ("error" in target) throw new Error(target.error);
    const upload = openPrReportUpload({ target, key: "12/abc", stage: "apply", warn: () => {} });
    upload.line(line("run-start"));
    upload.line(line("wave-settle", { wave: 1 }));
    await new Promise((r) => setImmediate(r));
    const events = join(dir, "12", "abc", "pr-apply.events.jsonl");
    expect(await readFile(events, "utf8")).toBe(line("run-start") + line("wave-settle", { wave: 1 }));
    upload.line(line("run-settle"));
    upload.file("change-set.json", "{}\n");
    await upload.close();
    expect((await readFile(events, "utf8")).split("\n").filter(Boolean)).toHaveLength(3);
    expect(await readFile(join(dir, "12", "abc", "change-set.json"), "utf8")).toBe("{}\n");
  });

  test("s3://: the AWS CLI copies each object from its stdin, with the content type, and chant hands it no credential", async () => {
    const runs: Array<{ args: string[]; stdin: string }> = [];
    const put = reportPut({ scheme: "s3", url: "s3://b/p", bucket: "b", prefix: "p" }, async (args, stdin) => {
      runs.push({ args, stdin });
    });
    await put("12/abc/pr-plan.json", "{}\n", "application/json");
    expect(runs).toEqual([{ args: ["s3", "cp", "-", "s3://b/p/12/abc/pr-plan.json", "--content-type", "application/json", "--only-show-errors"], stdin: "{}\n" }]);
  });
});
