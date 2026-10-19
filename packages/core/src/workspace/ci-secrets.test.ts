/**
 * #4096: the chant runner's secrets file, its allowlist, and the redactor
 * built from it. Each file is written to its own scratch directory.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, scratchDir } from "./__fixtures__/contract-repo";
import { ciRedactor, ciSecretsFor, CiSecretsError, parseCiSecrets, parseDotenv, readCiSecrets } from "./ci-secrets";
import { ciSecretsOf } from "./ci-run";
import { redactorOf, redactText } from "../op/redact";
import { parseArgs } from "../cli/parse-args";

afterAll(cleanScratch);

function fileWithMode(text: string, mode: number): string {
  const file = join(scratchDir("chant-ci-secrets-"), "secrets.env");
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
}

describe("the secrets file (#4096)", () => {
  test.skipIf(process.platform === "win32")("a file its group or other users can read or change is refused, as ssh refuses a loose key", () => {
    for (const mode of [0o644, 0o640, 0o604, 0o620, 0o660]) {
      const file = fileWithMode("A_TOKEN=abcdef\n", mode);
      expect(() => readCiSecrets(file)).toThrow(CiSecretsError);
      expect(() => readCiSecrets(file)).toThrow(new RegExp(`has mode 0${mode.toString(8)}.*chmod 600`));
    }
    for (const mode of [0o600, 0o400]) expect(readCiSecrets(fileWithMode("A_TOKEN=abcdef\n", mode)).values).toEqual({ A_TOKEN: "abcdef" });
    // CHANT_CI_SECRETS names the file when --secrets does not, and the same check applies.
    const loose = fileWithMode("A_TOKEN=abcdef\n", 0o644);
    expect(() => ciSecretsOf(undefined, { CHANT_CI_SECRETS: loose })).toThrow(/chmod 600/);
    expect(ciSecretsOf(undefined, { CHANT_CI_SECRETS: fileWithMode("A_TOKEN=abcdef\n", 0o600) })?.values).toEqual({ A_TOKEN: "abcdef" });
    expect(ciSecretsOf(undefined, {})).toBeUndefined();
    expect(() => readCiSecrets(join(scratchDir("chant-ci-secrets-"), "missing.env"))).toThrow(/can't be read: ENOENT/);
  });

  test("dotenv: comments, export, quotes and escapes, and errors that name the line and not the value", () => {
    const text = [
      "# cloud",
      "export AWS_ACCESS_KEY_ID=AKIAEXAMPLE",
      "AWS_SECRET_ACCESS_KEY = 'single # kept'",
      'PEM="line one\\nline two"',
      "PLAIN=value # a comment",
      "",
      'MULTI="a',
      'b"',
    ].join("\n");
    expect(parseDotenv(text, "s.env")).toEqual({
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "single # kept",
      PEM: "line one\nline two",
      PLAIN: "value",
      MULTI: "a\nb",
    });
    expect(() => parseDotenv("A=1\nnot a line hunter2\n", "s.env")).toThrow(/^s\.env:2: expected NAME=value$/);
    expect(() => parseDotenv('A="unclosed hunter2', "s.env")).toThrow(/s\.env:1: the value of A has no closing "/);
    expect(() => parseDotenv("A=1\nA=2\n", "s.env")).toThrow(/A is set twice/);
    expect(() => parseCiSecrets("CHANT_RUNNER_KEY=x\n", "s.env")).toThrow(/runner key is never passed to a job/);
  });

  test("JSON: a flat map, or secrets with an allowlist for each job", () => {
    expect(parseCiSecrets('{ "A_TOKEN": "abcd" }', "s.json")).toEqual({ values: { A_TOKEN: "abcd" }, jobs: {} });
    const s = { file: "s.json", ...parseCiSecrets(JSON.stringify({ secrets: { A: "aaaa", B: "bbbb" }, jobs: { plan: ["A"] } }), "s.json") };
    expect(ciSecretsFor(s, "plan")).toEqual({ A: "aaaa" });
    expect(ciSecretsFor(s, "apply")).toEqual({ A: "aaaa", B: "bbbb" });
    expect(ciSecretsFor(undefined, "plan")).toEqual({});
    expect(ciSecretsFor({ ...s, jobs: { plan: [] } }, "plan")).toEqual({});
    expect(() => parseCiSecrets(JSON.stringify({ secrets: { A: "aaaa" }, jobs: { plan: ["C"] } }), "s.json")).toThrow(/jobs\.plan names C, which the file does not set/);
    expect(() => parseCiSecrets(JSON.stringify({ secrets: { A: "aaaa" }, jobs: { deploy: [] } }), "s.json")).toThrow(/the jobs are plan and apply/);
    expect(() => parseCiSecrets('{ "A": 1 }', "s.json")).toThrow(/must be a string/);
    // A parse error does not quote the text, which may hold a secret.
    expect(() => parseCiSecrets('{ "A": "hunter2', "s.json")).toThrow(/^s\.json starts with \{, and is not valid JSON$/);
  });

  test("ci run and ci serve take --secrets", () => {
    expect(parseArgs(["ci", "run", "plan", "--secrets", "/etc/chant/ci.env"])).toMatchObject({ ciSecrets: "/etc/chant/ci.env" });
    expect(parseArgs(["ci", "serve", "--secrets", "s.json"])).toMatchObject({ ciSecrets: "s.json" });
    expect(() => parseArgs(["ci", "run", "plan", "--secrets"])).toThrow(/--secrets needs/);
  });
});

describe("redaction (#4096)", () => {
  test("every secret, and each job variable whose name looks secret, is ***; a value under 4 characters is kept", () => {
    const secrets = { file: "s", values: { DB: "hunter22", PIN: "abc" }, jobs: {} };
    const redact = ciRedactor({ GITHUB_TOKEN: "ghp_abcdef", AWS_SECRET_ACCESS_KEY: "aws-secret", MY_PASSWORD: "pw-1234", HOME: "/home/runner", GITHUB_REPOSITORY: "acme/estate" }, secrets)!;
    expect(redact("hunter22 ghp_abcdef aws-secret pw-1234 abc /home/runner acme/estate")).toBe("*** *** *** *** abc /home/runner acme/estate");
    expect(ciRedactor({ HOME: "/h" })).toBeUndefined();
    expect(redactorOf(["abc", ""])).toBeUndefined();
  });

  test("a JSON document or line stays JSON, a value that spans lines is redacted line by line, and the longest value wins", () => {
    const redact = redactorOf(["true", 'qu"ote', "-----BEGIN KEY-----\nAAAABBBB\n-----END KEY-----", "abcd", "abcdefgh"])!;
    const line = `${JSON.stringify({ ok: true, msg: "it is true", q: 'say qu"ote' })}\n`;
    const out = redactText(line, redact);
    expect(JSON.parse(out)).toEqual({ ok: true, msg: "it is ***", q: "say ***" });
    expect(out.endsWith("\n")).toBe(true);
    expect(redactText("[x] cmd | AAAABBBB", redact)).toBe("[x] cmd | ***");
    expect(redact("abcdefgh abcd")).toBe("*** ***");
    expect(redactText("nothing here", redact)).toBe("nothing here");
    // JSON Lines: each line on its own.
    expect(redactText('{"a":"abcd"}\nplain abcd\n', redact)).toBe('{"a":"***"}\nplain ***\n');
  });
});
