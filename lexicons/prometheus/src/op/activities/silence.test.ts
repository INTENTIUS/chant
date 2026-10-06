import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withOpRunContext } from "@intentius/chant/op";
import { alertmanagerSilence, alertmanagerUnsilence, apiMatchers, recordPath } from "./silence";

/** An Alertmanager API stand-in: creates silences, expires them once, then answers "already expired". */
function fakeAlertmanager() {
  const created: Array<{ id: string; body: Record<string, unknown> }> = [];
  const expired = new Set<string>();
  const calls: string[] = [];
  let n = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST" && url.endsWith("/api/v2/silences")) {
      const id = `s-${++n}`;
      created.push({ id, body: JSON.parse(String(init.body)) });
      return Response.json({ silenceID: id });
    }
    const m = /\/api\/v2\/silence\/(.+)$/.exec(url);
    if (init?.method === "DELETE" && m) {
      const id = decodeURIComponent(m[1]);
      if (!created.some((c) => c.id === id)) return new Response("silence not found", { status: 404 });
      if (expired.has(id)) return new Response(`silence ${id} already expired`, { status: 500 });
      expired.add(id);
      return new Response(null, { status: 200 });
    }
    return new Response("no", { status: 400 });
  }) as typeof fetch;
  return { f, created, expired, calls };
}

const NOW = () => new Date("2026-10-06T12:00:00.000Z");

describe("Alertmanager matchers", () => {
  test("matcher strings and label sets as API matchers", () => {
    expect(apiMatchers(['alertname="SloBurn"', 'severity=~"page|ticket"', 'env!="dev"'])).toEqual([
      { name: "alertname", value: "SloBurn", isRegex: false, isEqual: true },
      { name: "severity", value: "page|ticket", isRegex: true, isEqual: true },
      { name: "env", value: "dev", isRegex: false, isEqual: false },
    ]);
    expect(apiMatchers({ slo: "checkout" })).toEqual([{ name: "slo", value: "checkout", isRegex: false, isEqual: true }]);
    expect(() => apiMatchers(["not a matcher"])).toThrow(/matcher/);
    expect(() => apiMatchers([])).toThrow(/at least one/);
  });

  test("a record name cannot leave the record directory", () => {
    expect(() => recordPath("../x")).toThrow(/record/);
  });
});

describe("alertmanagerSilence and alertmanagerUnsilence", () => {
  test("silence, record the id, then expire it from the record", async () => {
    const am = fakeAlertmanager();
    const recordDir = mkdtempSync(join(tmpdir(), "chant-silence-"));
    const r = await withOpRunContext({ op: "deploy", runId: "run-1", passedGates: [] }, () =>
      alertmanagerSilence({ url: "http://am:9093/", matchers: { slo: "checkout" }, duration: "30m", recordDir, record: "deploy", _fetch: am.f, _now: NOW }),
    );
    expect(r).toMatchObject({ silenceId: "s-1", url: "http://am:9093", startsAt: "2026-10-06T12:00:00.000Z", endsAt: "2026-10-06T12:30:00.000Z" });
    expect(am.created[0].body).toMatchObject({ createdBy: "chant op deploy", comment: "chant run deploy (run-1)", matchers: [{ name: "slo", value: "checkout" }] });
    const recorded = JSON.parse(readFileSync(r.record, "utf8"));
    expect(recorded.silences).toEqual([{ silenceId: "s-1", url: "http://am:9093", endsAt: "2026-10-06T12:30:00.000Z", run: "run-1" }]);

    const u = await alertmanagerUnsilence({ recordDir, record: "deploy", _fetch: am.f });
    expect(u.expired).toEqual(["s-1"]);
    expect(am.calls).toContain("DELETE http://am:9093/api/v2/silence/s-1");
    expect(JSON.parse(readFileSync(r.record, "utf8")).silences).toEqual([]);
  });

  test("expiring twice, or a silence Alertmanager does not know, is done, not an error", async () => {
    const am = fakeAlertmanager();
    const recordDir = mkdtempSync(join(tmpdir(), "chant-silence-"));
    await alertmanagerSilence({ url: "http://am:9093", matchers: ['alertname="X"'], duration: "1h", recordDir, _fetch: am.f });
    await alertmanagerUnsilence({ url: "http://am:9093", silenceId: "s-1", recordDir, _fetch: am.f });
    await expect(alertmanagerUnsilence({ url: "http://am:9093", silenceId: "s-1", recordDir, _fetch: am.f })).resolves.toMatchObject({ expired: ["s-1"] });
    await expect(alertmanagerUnsilence({ url: "http://am:9093", silenceId: "nope", recordDir, _fetch: am.f })).resolves.toMatchObject({ expired: ["nope"] });
  });

  test("with nothing recorded, unsilence does nothing and writes no record", async () => {
    const am = fakeAlertmanager();
    const recordDir = mkdtempSync(join(tmpdir(), "chant-silence-"));
    await expect(alertmanagerUnsilence({ recordDir, _fetch: am.f })).resolves.toEqual({ expired: [], failed: [] });
    expect(am.calls).toEqual([]);
    expect(existsSync(join(recordDir, "silence.json"))).toBe(false);
  });

  test("a silence that cannot be expired stays recorded and fails the step", async () => {
    const am = fakeAlertmanager();
    const recordDir = mkdtempSync(join(tmpdir(), "chant-silence-"));
    await alertmanagerSilence({ url: "http://am:9093", matchers: { a: "1" }, duration: "1h", recordDir, _fetch: am.f });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(alertmanagerUnsilence({ recordDir, _fetch: down })).rejects.toThrow(/could not expire 1 silence/);
    expect(JSON.parse(readFileSync(join(recordDir, "silence.json"), "utf8")).silences).toHaveLength(1);
  });

  test("a bad duration or an API error fails before anything is recorded", async () => {
    const recordDir = mkdtempSync(join(tmpdir(), "chant-silence-"));
    await expect(alertmanagerSilence({ matchers: { a: "1" }, duration: "soon", recordDir })).rejects.toThrow(/not a Prometheus duration/);
    const refuse = (async () => new Response("bad matchers", { status: 400 })) as unknown as typeof fetch;
    await expect(alertmanagerSilence({ matchers: { a: "1" }, duration: "5m", recordDir, _fetch: refuse })).rejects.toThrow(/HTTP 400/);
    expect(existsSync(join(recordDir, "silence.json"))).toBe(false);
  });
});
