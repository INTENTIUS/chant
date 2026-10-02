/**
 * The trusted-publisher audit gates the release (#3191): a package npm will
 * not exchange an OIDC token for fails it, and publish.yml's `publish` job
 * needs it. With no id-token to ask with, it can check nothing and passes
 * with a warning.
 *
 * Driven by a fake `curl` on PATH: the id-token request answers with a token
 * (or nothing), and each exchange answers with the status listed for that
 * package in `statuses`.
 */

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "audit-trusted-publishers.sh");
let dir: string;
let bin: string;

const put = (rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

const FAKE_CURL = `#!/usr/bin/env bash
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -H|-X|-w) shift ;;
    http*) url="$1" ;;
  esac
  shift
done
case "$url" in
  *audience=npm*)
    [ -f "$FAKE_BIN/no-idtoken" ] || echo '{"value":"fake-id-token"}'
    exit 0 ;;
  */oidc/token/exchange/package/*)
    name=$(printf '%s' "\${url##*/package/}" | sed 's/%2f/\\//g')
    status=$(awk -v n="$name" '$1 == n { print $2 }' "$FAKE_BIN/statuses")
    status=\${status:-404}
    case "$status" in
      2*) echo '{"token":"never-printed"}' > "$out" ;;
      *)  echo '{"message":"package not found"}' > "$out" ;;
    esac
    printf '%s' "$status" ;;
esac
`;

function audit(statuses: Record<string, number>, opts: { idTokenEnv?: boolean; noIdToken?: boolean } = {}) {
  writeFileSync(
    join(bin, "statuses"),
    Object.entries(statuses)
      .map(([n, s]) => `${n} ${s}\n`)
      .join(""),
  );
  if (opts.noIdToken) writeFileSync(join(bin, "no-idtoken"), "");
  const summary = join(dir, ".summary");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_BIN: bin,
    GITHUB_STEP_SUMMARY: summary,
  };
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (opts.idTokenEnv !== false) {
    env.ACTIONS_ID_TOKEN_REQUEST_URL = "https://token.actions.example/?x=1";
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "request-token";
  }
  const r = spawnSync("bash", [script], { cwd: dir, encoding: "utf-8", env });
  let written = "";
  try {
    written = readFileSync(summary, "utf-8");
  } catch {}
  return { status: r.status, out: r.stdout + r.stderr, summary: written };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-audit-tp-"));
  bin = join(dir, ".fake-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  chmodSync(join(bin, "curl"), 0o755);
  put("packages/core/package.json", '{ "name": "@intentius/chant", "version": "0.2.0" }\n');
  put("lexicons/otel/package.json", '{ "name": "@intentius/chant-lexicon-otel", "version": "0.2.0" }\n');
  put("packages/test-utils/package.json", '{ "name": "@intentius/test-utils", "private": true }\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("audit-trusted-publishers.sh (#3191)", () => {
  it("passes when every publishable package has a record", () => {
    const r = audit({ "@intentius/chant": 201, "@intentius/chant-lexicon-otel": 201 });
    expect(r.status).toBe(0);
    expect(r.out).toContain("configured: 2  missing: 0  unknown: 0");
    expect(r.summary).toContain("All 2 publishable packages have a working record.");
    // A private package is never asked about.
    expect(r.out).not.toContain("test-utils");
    expect(r.out).not.toContain("never-printed");
  });

  it("fails when a package has no record (chant-v0.81.0)", () => {
    const r = audit({ "@intentius/chant": 201, "@intentius/chant-lexicon-otel": 404 });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/MISSING\s+@intentius\/chant-lexicon-otel\s+\(HTTP 404: package not found\)/);
    expect(r.out).toContain("::error::");
    expect(r.summary).toContain("- `@intentius/chant-lexicon-otel`");
    expect(r.summary).toContain("workflow `publish.yml`");
  });

  it("fails when the registry gives no usable answer, reported apart from a missing record", () => {
    const r = audit({ "@intentius/chant": 201, "@intentius/chant-lexicon-otel": 503 });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/UNKNOWN\s+@intentius\/chant-lexicon-otel/);
    expect(r.out).toContain("missing: 0  unknown: 1");
    expect(r.summary).toContain("could not be checked");
  });

  it("warns and passes when the job has no id-token permission", () => {
    const r = audit({ "@intentius/chant-lexicon-otel": 404 }, { idTokenEnv: false });
    expect(r.status).toBe(0);
    expect(r.out).toContain("::warning::No id-token permission");
    expect(r.out).not.toContain("MISSING");
  });

  it("warns and passes when GitHub issues no id-token", () => {
    const r = audit({ "@intentius/chant-lexicon-otel": 404 }, { noIdToken: true });
    expect(r.status).toBe(0);
    expect(r.out).toContain("::warning::GitHub did not issue an id-token");
    expect(r.out).not.toContain("MISSING");
  });
});
