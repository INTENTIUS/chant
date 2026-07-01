import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  checkRollingUpgrade,
  classifyDelta,
  diffRollingSurface,
  computeAzureApiVersionDelta,
  extractAzureProvider,
  diffAzureApiVersions,
} from "./rolling-upgrade";
import type { SurfaceSnapshot } from "./surface-snapshot";
import type { RegenResult, RegenOptions } from "./lexicon-regen";
import { diffSurface } from "./surface-snapshot";

// ── Fixture snapshots ─────────────────────────────────────────────────

function baselineAws(): SurfaceSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: {
      Bucket: {
        kind: "resource",
        resourceType: "AWS::S3::Bucket",
        attrs: ["Arn"],
        props: ["BucketName:false", "Tags:false"],
        taggable: true,
      },
      Bucket_Tag: { kind: "property", resourceType: "AWS::S3::Bucket.Tag" },
    },
  };
}

/** Adds a new resource → additive upgrade. */
function freshAwsAdditive(): SurfaceSnapshot {
  const s = baselineAws();
  s.entries.Table = {
    kind: "resource",
    resourceType: "AWS::DynamoDB::Table",
    attrs: ["Arn"],
    props: ["TableName:false"],
    taggable: true,
  };
  return s;
}

/** Removes a resource → breaking upgrade. */
function freshAwsBreaking(): SurfaceSnapshot {
  const s = baselineAws();
  delete s.entries.Bucket_Tag;
  return s;
}

function azureBaseline(): SurfaceSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: {
      StorageAccount: {
        kind: "resource",
        resourceType: "Microsoft.Storage/storageAccounts",
        props: ["name:true"],
      },
      VirtualMachine: {
        kind: "resource",
        resourceType: "Microsoft.Compute/virtualMachines",
        props: ["name:true"],
      },
    },
  };
}

/** Adds a resource from a brand-new provider. */
function azureFreshNewProvider(): SurfaceSnapshot {
  const s = azureBaseline();
  s.entries.Vault = {
    kind: "resource",
    resourceType: "Microsoft.KeyVault/vaults",
    props: ["name:true"],
  };
  return s;
}

// ── Mock regen ────────────────────────────────────────────────────────

function makeRegen(
  fresh: SurfaceSnapshot | null,
  baseline: SurfaceSnapshot,
  ok = true,
): (opts: RegenOptions) => Promise<RegenResult> {
  return async () => {
    const delta = fresh
      ? diffSurface(baseline, fresh)
      : { added: [], changed: [], removed: [], severity: "none" as const };
    const changed =
      delta.added.length > 0 || delta.changed.length > 0 || delta.removed.length > 0;
    return {
      ok,
      changed,
      severity: delta.severity,
      delta,
      deltaText: changed ? "delta" : "",
      failures: ok ? [] : [{ step: "generate", output: "boom" }],
      freshSnapshot: fresh,
    };
  };
}

// ── Test dir helper ───────────────────────────────────────────────────

/** Create a fake lexicon dir with a package.json and committed baseline snapshot. */
function makeLexiconDir(name: string, baseline: SurfaceSnapshot): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-rolling-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `@intentius/chant-lexicon-${name}` }),
  );
  writeFileSync(join(dir, "surface.snapshot.json"), JSON.stringify(baseline, null, 2));
  mkdirSync(join(dir, "src", "generated"), { recursive: true });
  return dir;
}

// ── classifyDelta (pure) ──────────────────────────────────────────────

describe("classifyDelta", () => {
  test("unchanged surface → no upgrade, none severity", () => {
    const delta = diffRollingSurface(baselineAws(), baselineAws());
    expect(classifyDelta(delta)).toEqual({ hasUpgrade: false, severity: "none" });
  });

  test("added resource → upgrade, additive severity", () => {
    const delta = diffRollingSurface(baselineAws(), freshAwsAdditive());
    expect(classifyDelta(delta)).toEqual({ hasUpgrade: true, severity: "additive" });
  });

  test("removed resource → upgrade, breaking severity", () => {
    const delta = diffRollingSurface(baselineAws(), freshAwsBreaking());
    const c = classifyDelta(delta);
    expect(c.hasUpgrade).toBe(true);
    expect(c.severity).toBe("breaking");
  });
});

// ── checkRollingUpgrade (mocked regen) ────────────────────────────────

describe("checkRollingUpgrade — surface changed vs unchanged", () => {
  test("unchanged surface → hasUpgrade false", async () => {
    const dir = makeLexiconDir("aws", baselineAws());
    try {
      const res = await checkRollingUpgrade({
        lexiconDir: dir,
        _regenFn: makeRegen(baselineAws(), baselineAws()),
      });
      expect(res.lexicon).toBe("aws");
      expect(res.hasUpgrade).toBe(false);
      expect(res.severity).toBe("none");
      expect(res.validationOk).toBe(true);
      expect(res.deltaText).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("additive surface change → hasUpgrade true, additive", async () => {
    const dir = makeLexiconDir("aws", baselineAws());
    try {
      const res = await checkRollingUpgrade({
        lexiconDir: dir,
        _regenFn: makeRegen(freshAwsAdditive(), baselineAws()),
      });
      expect(res.hasUpgrade).toBe(true);
      expect(res.severity).toBe("additive");
      expect(res.delta.added.map((a) => a.name)).toContain("Table");
      expect(res.deltaText).not.toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("breaking surface change → hasUpgrade true, breaking", async () => {
    const dir = makeLexiconDir("aws", baselineAws());
    try {
      const res = await checkRollingUpgrade({
        lexiconDir: dir,
        _regenFn: makeRegen(freshAwsBreaking(), baselineAws()),
      });
      expect(res.hasUpgrade).toBe(true);
      expect(res.severity).toBe("breaking");
      expect(res.delta.removed.map((r) => r.name)).toContain("Bucket_Tag");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("failed regen surfaces validationOk=false and failures", async () => {
    const dir = makeLexiconDir("aws", baselineAws());
    try {
      const res = await checkRollingUpgrade({
        lexiconDir: dir,
        _regenFn: makeRegen(freshAwsAdditive(), baselineAws(), false),
      });
      expect(res.validationOk).toBe(false);
      expect(res.failures.length).toBeGreaterThan(0);
      // Still reports the delta so the failure carries the diff
      expect(res.hasUpgrade).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── azure lexicon detection + apiVersionDelta ─────────────────────────

describe("checkRollingUpgrade — azure", () => {
  test("detects azure lexicon by package name", async () => {
    const dir = makeLexiconDir("azure", azureBaseline());
    try {
      const res = await checkRollingUpgrade({
        lexiconDir: dir,
        _regenFn: makeRegen(azureBaseline(), azureBaseline()),
      });
      expect(res.lexicon).toBe("azure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("new provider shows up in apiVersionDelta", async () => {
    const dir = makeLexiconDir("azure", azureBaseline());
    try {
      const res = await checkRollingUpgrade({
        lexiconDir: dir,
        _regenFn: makeRegen(azureFreshNewProvider(), azureBaseline()),
      });
      expect(res.hasUpgrade).toBe(true);
      const kv = res.apiVersionDelta.find((c) => c.provider === "Microsoft.KeyVault");
      expect(kv).toBeDefined();
      expect(kv!.kind).toBe("added");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("aws has empty apiVersionDelta", async () => {
    const dir = makeLexiconDir("aws", baselineAws());
    try {
      const res = await checkRollingUpgrade({
        lexiconDir: dir,
        _regenFn: makeRegen(freshAwsAdditive(), baselineAws()),
      });
      expect(res.apiVersionDelta).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── extractAzureProvider (pure) ───────────────────────────────────────

describe("extractAzureProvider", () => {
  test("extracts provider from resourceType", () => {
    expect(extractAzureProvider("Microsoft.Storage/storageAccounts")).toBe("Microsoft.Storage");
    expect(extractAzureProvider("Microsoft.Compute/virtualMachines/extensions")).toBe(
      "Microsoft.Compute",
    );
  });

  test("returns null for non-ARM types", () => {
    expect(extractAzureProvider("AWS::S3::Bucket")).toBeNull();
    expect(extractAzureProvider("")).toBeNull();
    expect(extractAzureProvider("Microsoft.Storage")).toBeNull();
  });
});

// ── computeAzureApiVersionDelta (pure) ────────────────────────────────

describe("computeAzureApiVersionDelta", () => {
  test("reports added and removed providers", () => {
    const delta = computeAzureApiVersionDelta(azureBaseline(), azureFreshNewProvider());
    expect(delta).toHaveLength(1);
    expect(delta[0]).toMatchObject({ provider: "Microsoft.KeyVault", kind: "added" });
  });

  test("no change when providers identical", () => {
    expect(computeAzureApiVersionDelta(azureBaseline(), azureBaseline())).toEqual([]);
  });

  test("reports removed provider", () => {
    const shrunk: SurfaceSnapshot = {
      ...azureBaseline(),
      entries: { StorageAccount: azureBaseline().entries.StorageAccount },
    };
    const delta = computeAzureApiVersionDelta(azureBaseline(), shrunk);
    expect(delta).toEqual([
      { provider: "Microsoft.Compute", before: "latest", after: null, kind: "removed" },
    ]);
  });
});

// ── diffAzureApiVersions (pure) ───────────────────────────────────────

describe("diffAzureApiVersions", () => {
  test("detects version bump as updated", () => {
    const base = new Map([["Microsoft.Compute", "2022-03-01"]]);
    const fresh = new Map([["Microsoft.Compute", "2023-07-01"]]);
    const delta = diffAzureApiVersions(base, fresh);
    expect(delta).toEqual([
      {
        provider: "Microsoft.Compute",
        before: "2022-03-01",
        after: "2023-07-01",
        kind: "updated",
      },
    ]);
  });

  test("detects added and removed providers", () => {
    const base = new Map([["Microsoft.Old", "2020-01-01"]]);
    const fresh = new Map([["Microsoft.New", "2024-01-01"]]);
    const delta = diffAzureApiVersions(base, fresh);
    expect(delta).toEqual([
      { provider: "Microsoft.New", before: null, after: "2024-01-01", kind: "added" },
      { provider: "Microsoft.Old", before: "2020-01-01", after: null, kind: "removed" },
    ]);
  });

  test("no change when versions identical", () => {
    const m = new Map([["Microsoft.Storage", "2023-01-01"]]);
    expect(diffAzureApiVersions(m, new Map(m))).toEqual([]);
  });
});
