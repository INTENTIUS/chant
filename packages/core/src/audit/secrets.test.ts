import { describe, test, expect } from "vitest";
import { scanForSecrets, fingerprintSecret, parseSecretsConfig, looksLikeIdentifierSlug, ENTROPY_RULE_ID, type ScannableFile } from "./secrets";

// Deliberately fake, non-functional values shaped like each detector's
// pattern (so the regexes under test have something real to match). Built via
// string concatenation — never a contiguous literal in this file's raw bytes
// — so pushing this file doesn't trip GitHub's own secret-scanning push
// protection on what are just test fixtures.
const FAKE_AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
const FAKE_AWS_SECRET = "aB3dEfGhIjKlMnOpQrStUvWxYz01234567" + "89+/Q9";
const FAKE_GH_TOKEN = "ghp_" + "a".repeat(20) + "B1C2D3E4F5G6H7I8J9K0";
const FAKE_SLACK_TOKEN = "xoxb-123456789012-1234567890123-" + "abcdefghijklmnopqrstuvwx";
const FAKE_GOOGLE_KEY = "AIza" + "Sy" + "A".repeat(33);
const FAKE_STRIPE_LIVE = "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const FAKE_STRIPE_TEST = "sk_test_" + "4eC39HqLyjWDarjtT1zdp7dc";

function ids(files: ScannableFile[], opts?: Parameters<typeof scanForSecrets>[1]): string[] {
  return scanForSecrets(files, opts).map((f) => f.checkId);
}

describe("scanForSecrets — pattern detectors (positive + negative)", () => {
  test("SEC001: AWS access key ID", () => {
    const hit = FAKE_AWS_KEY;
    expect(ids([{ path: "a.env", content: `KEY=${hit}\n` }])).toContain("SEC001");
    // AWS's own documented example key is a well-known placeholder.
    expect(ids([{ path: "a.env", content: "KEY=AKIAIOSFODNN7EXAMPLE\n" }])).not.toContain("SEC001");
  });

  test("SEC002: AWS secret access key (contextual)", () => {
    const hit = `aws_secret_access_key = "${FAKE_AWS_SECRET}"`;
    expect(ids([{ path: "creds.ini", content: hit }])).toContain("SEC002");
    // The AWS docs' own example secret key contains "EXAMPLE" — a placeholder.
    expect(ids([{ path: "creds.ini", content: 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"' }])).not.toContain("SEC002");
    // A reference, not a literal, is not a secret at all.
    expect(ids([{ path: "creds.ini", content: "aws_secret_access_key = ${AWS_SECRET}" }])).not.toContain("SEC002");
  });

  test("SEC003: GitHub token", () => {
    const hit = FAKE_GH_TOKEN;
    expect(ids([{ path: "notes.txt", content: hit }])).toContain("SEC003");
    expect(ids([{ path: "notes.txt", content: "ghp_ this is not a token, just prose" }])).not.toContain("SEC003");
  });

  test("SEC004: Slack token", () => {
    const hit = FAKE_SLACK_TOKEN;
    expect(ids([{ path: "notes.txt", content: hit }])).toContain("SEC004");
    expect(ids([{ path: "notes.txt", content: "no slack token here" }])).not.toContain("SEC004");
  });

  test("SEC005: Google API key", () => {
    const hit = FAKE_GOOGLE_KEY;
    expect(hit.length).toBe(39);
    expect(ids([{ path: "config.json", content: `{"key": "${hit}"}` }])).toContain("SEC005");
    expect(ids([{ path: "config.json", content: '{"key": "not-a-google-key"}' }])).not.toContain("SEC005");
  });

  test("SEC006: Stripe live secret key", () => {
    const hit = FAKE_STRIPE_LIVE;
    expect(ids([{ path: ".env", content: `STRIPE_KEY=${hit}\n` }])).toContain("SEC006");
    // Test-mode keys are out of scope for this rule.
    expect(ids([{ path: ".env", content: `STRIPE_KEY=${FAKE_STRIPE_TEST}\n` }])).not.toContain("SEC006");
  });

  test("SEC007: PEM private key block", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumqCp9nkc/AI5wpN0/f9YkFxx",
      "wPqDgCUvo3PZ4d1JXCyv6l3lRb8lgSVeYjfXOsi9NxWTeR/xdz1Tv7DGwmlfjO7X",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(ids([{ path: "id_rsa", content: pem }])).toContain("SEC007");
    expect(ids([{ path: "id_rsa.pub", content: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC user@host" }])).not.toContain("SEC007");
  });

  test("SEC008: bearer/authorization token", () => {
    const hit = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc123def456ghi789";
    expect(ids([{ path: "curl.sh", content: hit }])).toContain("SEC008");
    expect(ids([{ path: "curl.sh", content: "Authorization: Bearer ${TOKEN}" }])).not.toContain("SEC008");
  });

  test("SEC009: credentials embedded in a connection string", () => {
    const hit = "postgres://appuser:S7fkq2!zXpLm9@db.internal:5432/prod";
    expect(ids([{ path: "settings.py", content: `DATABASE_URL = "${hit}"` }])).toContain("SEC009");
    // Bland placeholder creds are excluded.
    expect(ids([{ path: "settings.py", content: 'DATABASE_URL = "postgres://user:password@localhost:5432/dev"' }])).not.toContain("SEC009");
  });

  test("SEC010: high-entropy catch-all, and does not double-flag a pattern-matched value", () => {
    const random = "kQ7mZ9pL2xR8vT4nW1sD6uJ3";
    expect(ids([{ path: "notes.txt", content: `token = ${random}` }], { entropyMinLength: 20 })).toContain(ENTROPY_RULE_ID);
    // A git-sha-shaped pure-hex run is not flagged (common false positive source).
    expect(ids([{ path: "lock.json", content: "resolved-commit: 4b825dc642cb6eb9a060e54bf8d69288fbee4904" }], { entropyMinLength: 20 })).not.toContain(
      ENTROPY_RULE_ID,
    );
    // Already caught by a pattern detector — the entropy pass must not also fire on the same text.
    const findings = scanForSecrets([{ path: "a.env", content: `KEY=${FAKE_AWS_KEY}` }], { entropyMinLength: 10 });
    expect(findings.filter((f) => f.checkId === ENTROPY_RULE_ID)).toHaveLength(0);
  });
});

describe("entropy heuristic tunability (#443)", () => {
  const content = "token = kQ7mZ9pL2xR8vT4nW1sD6uJ3";

  test("default threshold catches the high-entropy token", () => {
    expect(ids([{ path: "f.txt", content }])).toContain(ENTROPY_RULE_ID);
  });

  test("raising the threshold suppresses it", () => {
    expect(ids([{ path: "f.txt", content }], { entropyThreshold: 6.5 })).not.toContain(ENTROPY_RULE_ID);
  });

  test("raising the minimum length excludes short candidate tokens", () => {
    expect(ids([{ path: "f.txt", content }], { entropyMinLength: 100 })).not.toContain(ENTROPY_RULE_ID);
  });
});

describe("entropy heuristic — identifier/slug false-positive guard (#443)", () => {
  test("a dashed/slashed identifier (model id, package spec, image ref) is not flagged", () => {
    expect(ids([{ path: "fleet.yaml", content: "model: anthropic/claude-sonnet-4-6\n" }])).not.toContain(ENTROPY_RULE_ID);
    expect(ids([{ path: "package.json", content: '"some-package-name": "acme-widget-factory-lib"' }])).not.toContain(ENTROPY_RULE_ID);
  });

  test("a UUID-shaped value (hyphenated but not dictionary words) is still a candidate", () => {
    // Not asserting it fires (entropy of hex digits alone may sit under the default
    // threshold) — only that the slug guard doesn't blanket-exempt hyphenated values.
    expect(looksLikeIdentifierSlug("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });
});

describe("redaction guarantee (#443)", () => {
  test("the matched secret value never appears anywhere in a finding", () => {
    const secret = FAKE_AWS_KEY;
    const findings = scanForSecrets([{ path: "a.env", content: `AWS_ACCESS_KEY_ID=${secret}\n` }]);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      const serialized = JSON.stringify(f);
      expect(serialized).not.toContain(secret);
      expect(f.message).not.toContain(secret);
      expect(f.entity ?? "").not.toContain(secret);
    }
  });

  test("holds across every detector, including entropy and PEM blocks", () => {
    const pemBody = "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumqCp9nkc/AI5wpN0/f9YkFxx";
    const secrets = [FAKE_AWS_KEY, FAKE_GH_TOKEN, FAKE_SLACK_TOKEN, FAKE_GOOGLE_KEY, FAKE_STRIPE_LIVE, pemBody, "kQ7mZ9pL2xR8vT4nW1sD6uJ3"];
    const content = [
      FAKE_AWS_KEY,
      FAKE_GH_TOKEN,
      FAKE_SLACK_TOKEN,
      FAKE_GOOGLE_KEY,
      FAKE_STRIPE_LIVE,
      `-----BEGIN RSA PRIVATE KEY-----`,
      pemBody,
      `-----END RSA PRIVATE KEY-----`,
      `token = kQ7mZ9pL2xR8vT4nW1sD6uJ3`,
      `postgres://appuser:S7fkq2!zXpLm9@db.internal:5432/prod`,
    ].join("\n");

    const findings = scanForSecrets([{ path: "big.env", content }], { entropyMinLength: 20 });
    expect(findings.length).toBeGreaterThan(5);
    const dump = JSON.stringify(findings);
    for (const secret of secrets) expect(dump).not.toContain(secret);
    expect(dump).not.toContain("appuser:S7fkq2!zXpLm9");
  });

  test("a finding carries a fingerprint and file/line location instead of the value", () => {
    const [finding] = scanForSecrets([{ path: "a.env", content: `\n\nAWS=${FAKE_AWS_KEY}\n` }]);
    expect(finding.file).toBe("a.env");
    expect(finding.line).toBe(3);
    expect(finding.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("fingerprintSecret", () => {
  test("is deterministic and does not echo the input", () => {
    const fp1 = fingerprintSecret("super-secret-value");
    const fp2 = fingerprintSecret("super-secret-value");
    expect(fp1).toBe(fp2);
    expect(fp1).not.toContain("super-secret-value");
    expect(fp1).toMatch(/^[0-9a-f]{16}$/);
  });

  test("different inputs produce different fingerprints", () => {
    expect(fingerprintSecret("a")).not.toBe(fingerprintSecret("b"));
  });
});

describe("inline ignore marker (#443)", () => {
  const secret = FAKE_AWS_KEY;

  test("a same-line marker suppresses the finding", () => {
    const content = `AWS=${secret} # chant-audit-ignore\n`;
    expect(ids([{ path: "a.env", content }])).toEqual([]);
  });

  test("a marker scoped to a different rule id does not suppress", () => {
    const content = `AWS=${secret} # chant-audit-ignore: SEC099\n`;
    expect(ids([{ path: "a.env", content }])).toContain("SEC001");
  });

  test("a marker scoped to the matching rule id suppresses", () => {
    const content = `AWS=${secret} # chant-audit-ignore: SEC001\n`;
    expect(ids([{ path: "a.env", content }])).toEqual([]);
  });

  test("a marker on the line above suppresses (for blocks that can't carry a trailing comment)", () => {
    const pem = ["# chant-audit-ignore: SEC007", "-----BEGIN RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumqCp9nkc", "-----END RSA PRIVATE KEY-----"].join(
      "\n",
    );
    expect(ids([{ path: "id_rsa", content: pem }])).toEqual([]);
  });

  test("without a marker, the finding is not suppressed", () => {
    expect(ids([{ path: "a.env", content: `AWS=${secret}\n` }])).toContain("SEC001");
  });
});

describe("config allowlist (#443)", () => {
  const secret = FAKE_AWS_KEY;
  const content = `AWS=${secret}\n`;

  test("an allow entry matching ruleId + fingerprint suppresses the finding", () => {
    const fingerprint = fingerprintSecret(secret);
    const findings = scanForSecrets([{ path: "a.env", content }], { allow: [{ ruleId: "SEC001", fingerprint }] });
    expect(findings).toEqual([]);
  });

  test("a fingerprint-only allow entry suppresses regardless of file", () => {
    const fingerprint = fingerprintSecret(secret);
    expect(scanForSecrets([{ path: "a.env", content }], { allow: [{ fingerprint }] })).toEqual([]);
  });

  test("a mismatched fingerprint does not suppress", () => {
    const findings = scanForSecrets([{ path: "a.env", content }], { allow: [{ ruleId: "SEC001", fingerprint: "0000000000000000" }] });
    expect(findings.map((f) => f.checkId)).toContain("SEC001");
  });

  test("`file` alone (no ruleId or fingerprint) never blanket-allows a file", () => {
    const findings = scanForSecrets([{ path: "a.env", content }], { allow: [{ file: "a.env" }] });
    expect(findings.map((f) => f.checkId)).toContain("SEC001");
  });

  test("file is a discriminator when combined with ruleId: a different file is unaffected", () => {
    const fingerprint = fingerprintSecret(secret);
    const findings = scanForSecrets(
      [
        { path: "a.env", content },
        { path: "b.env", content },
      ],
      { allow: [{ ruleId: "SEC001", fingerprint, file: "a.env" }] },
    );
    expect(findings.map((f) => f.file)).toEqual(["b.env"]);
  });
});

describe("parseSecretsConfig", () => {
  test("parses a { secrets: {...} } wrapped config", () => {
    const opts = parseSecretsConfig(
      JSON.stringify({ secrets: { entropyThreshold: 4.5, entropyMinLength: 30, allow: [{ ruleId: "SEC010", file: "fixtures/x.env" }] } }),
    );
    expect(opts.entropyThreshold).toBe(4.5);
    expect(opts.entropyMinLength).toBe(30);
    expect(opts.allow).toEqual([{ ruleId: "SEC010", file: "fixtures/x.env", fingerprint: undefined }]);
  });

  test("parses a flat config with the same shape", () => {
    const opts = parseSecretsConfig(JSON.stringify({ entropyThreshold: 3.5 }));
    expect(opts.entropyThreshold).toBe(3.5);
  });

  test("is tolerant of malformed or empty content", () => {
    expect(parseSecretsConfig("not json")).toEqual({});
    expect(parseSecretsConfig("")).toEqual({});
    expect(parseSecretsConfig("null")).toEqual({});
    expect(parseSecretsConfig("[]")).toEqual({});
  });

  test("ignores non-object allow entries and non-string fields", () => {
    const opts = parseSecretsConfig(JSON.stringify({ allow: [null, 42, "x", { ruleId: 7, file: "ok.env" }] }));
    expect(opts.allow).toEqual([{ ruleId: undefined, file: "ok.env", fingerprint: undefined }]);
  });
});

describe("scanForSecrets — file handling", () => {
  test("empty content produces no findings", () => {
    expect(scanForSecrets([{ path: "empty.txt", content: "" }])).toEqual([]);
  });

  test("multiple files are scanned independently, each finding keeps its own file", () => {
    const secret = FAKE_AWS_KEY;
    const findings = scanForSecrets([
      { path: "one/.env", content: `A=${secret}\n` },
      { path: "two/.env", content: "A=just-a-normal-value\n" },
    ]);
    expect(findings.map((f) => f.file)).toEqual(["one/.env"]);
  });

  test("every finding is merge-worthy-shaped: guidance fixKind, security-relevant severity", () => {
    const findings = scanForSecrets([{ path: "a.env", content: `${FAKE_AWS_KEY}\n` }]);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].lexicon).toBe("secrets");
  });

  test("dependency lockfiles are skipped entirely — integrity hashes are not secrets", () => {
    // The exact false-positive class that failed the first dogfooding repo:
    // one lockfile's sha512 integrity fields read as hundreds of SEC010s.
    const integrity = `"integrity": "sha512-${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w3X4y5Z6".repeat(2)}"`;
    for (const path of ["package-lock.json", "web/package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum"]) {
      expect(scanForSecrets([{ path, content: `${integrity}\n` }]), path).toEqual([]);
    }
    // Even a real credential shape stays silent there — the file is skipped,
    // not entropy-tuned; a credential does not live in a machine-written
    // lockfile, and per-file skipping is what keeps the rule explainable.
    expect(scanForSecrets([{ path: "package-lock.json", content: `${FAKE_AWS_KEY}\n` }])).toEqual([]);
    // A non-lockfile with the same content still fires.
    expect(scanForSecrets([{ path: "config.json", content: `${integrity}\n` }]).length).toBeGreaterThan(0);
  });
});
