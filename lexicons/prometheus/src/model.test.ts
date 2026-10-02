import { describe, expect, test } from "vitest";
import { durationMs, formatDuration, isValidDuration } from "./duration";
import { matcher, matcherMatches, parseMatchers, type Matcher } from "./matchers";
import { checkPromql } from "./promql";
import { looksLikeAlertmanagerConfig, looksLikeRuleFile } from "./model";

describe("durations", () => {
  test.each(["0", "30s", "5m", "1h30m", "1d", "2w", "1y", "500ms", "1h0m0s", "1y2w3d4h5m6s7ms"])("%s is valid", (d) => {
    expect(isValidDuration(d)).toBe(true);
  });

  test.each(["", "5", "1.5h", "30m1h", "5 m", "5min", "-1m", "1h1h", "m"])("%j is not", (d) => {
    expect(isValidDuration(d)).toBe(false);
  });

  test("durationMs and formatDuration agree", () => {
    expect(durationMs("1h30m")).toBe(5_400_000);
    expect(durationMs("2d")).toBe(172_800_000);
    expect(durationMs("nope")).toBeUndefined();
    expect(formatDuration(5_400_000)).toBe("1h30m");
    expect(formatDuration(0)).toBe("0s");
    for (const d of ["28d", "6h", "30m", "1h5m", "4w"]) expect(durationMs(formatDuration(durationMs(d)!))).toBe(durationMs(d));
    expect(() => formatDuration(1.5)).toThrow();
  });
});

describe("matchers", () => {
  test("parses the four operators, quoted and unquoted", () => {
    expect(parseMatchers('severity="page"')).toEqual({ ok: true, matchers: [{ name: "severity", op: "=", value: "page" }] });
    expect(parseMatchers("severity!=info")).toEqual({ ok: true, matchers: [{ name: "severity", op: "!=", value: "info" }] });
    expect(parseMatchers('team=~"db|infra"')).toMatchObject({ ok: true, matchers: [{ op: "=~" }] });
    expect(parseMatchers('env!~"dev.*"')).toMatchObject({ ok: true, matchers: [{ op: "!~" }] });
  });

  test("parses a braced list and quoted commas", () => {
    const r = parseMatchers('{severity="page", msg="a, b"}');
    expect(r).toEqual({ ok: true, matchers: [{ name: "severity", op: "=", value: "page" }, { name: "msg", op: "=", value: "a, b" }] });
  });

  test.each(['severity', '="x"', 'sev-erity="x"', 'a="unterminated', 'a=~"("', "{a=b", "a=b c=d"])("rejects %j", (m) => {
    expect(parseMatchers(m).ok).toBe(false);
  });

  test("matches like Alertmanager, regexes anchored, missing labels empty", () => {
    const one = (s: string): Matcher => {
      const r = parseMatchers(s);
      if (!r.ok) throw new Error(r.error);
      return r.matchers[0];
    };
    const [eq, re, ne] = [one('severity="page"'), one('severity=~"pa"'), one('team!=""')];
    expect(matcherMatches(eq, { severity: "page" })).toBe(true);
    expect(matcherMatches(re, { severity: "page" })).toBe(false);
    expect(matcherMatches(ne, {})).toBe(false);
  });

  test("matcher() quotes the value", () => {
    expect(matcher("severity", "=", "page")).toBe('severity="page"');
    expect(parseMatchers(matcher("msg", "=", 'say "hi"'))).toMatchObject({ ok: true, matchers: [{ value: 'say "hi"' }] });
  });
});

describe("PromQL syntax", () => {
  test.each([
    'sum by (job) (rate(http_requests_total{job="api"}[5m])) > 0.1',
    "histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))",
    "1 - (sum(rate(good[1h])) / sum(rate(total[1h])))",
    'absent(up{job="api"} == 1)',
    "rate(x[5m:1m]) offset 1h",
    "a and on (job) b",
    "up\n  == 0",
  ])("accepts %s", (q) => {
    expect(checkPromql(q)).toEqual({ ok: true });
  });

  test.each([
    ["rate(x[5m]", "ends early"],
    ["x{a=\"b\"", "ends early"],
    ["foo bar", "offset 4"],
    ["rate(x[5q])", "syntax error"],
    ["notafunction(x)", "syntax error"],
    ['sum(rate(x[{{window}}]))', "syntax error"],
    ["", "empty"],
  ])("rejects %j", (q, msg) => {
    const r = checkPromql(q);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(msg);
  });
});

describe("document shape", () => {
  test("rule files", () => {
    expect(looksLikeRuleFile({ groups: [] })).toBe(true);
    expect(looksLikeRuleFile({ groups: [{ name: "a", rules: [] }] })).toBe(true);
    expect(looksLikeRuleFile({ groups: [{ name: "a" }] })).toBe(false);
    expect(looksLikeRuleFile({ spec: { groups: [] } })).toBe(false);
  });

  test("alertmanager configs", () => {
    expect(looksLikeAlertmanagerConfig({ route: { receiver: "a" } })).toBe(true);
    expect(looksLikeAlertmanagerConfig({ receivers: [] })).toBe(true);
    expect(looksLikeAlertmanagerConfig({ apiVersion: "v1", kind: "Receiver", receivers: [] })).toBe(false);
    expect(looksLikeAlertmanagerConfig({ receivers: { otlp: {} } })).toBe(false);
  });
});
