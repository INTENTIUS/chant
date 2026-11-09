import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { chantPackages, installLocalChant, LocalChantError, lockMismatches, packOrder, pointAtTarballs, productChantNames, productManifests, type Runner } from "./local-chant";

/** #4787: what terragucci's and plywood's scripts/chant-local.sh did, as chant's `chant dev local`. */

const write = (file: string, body: string | object) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
};

/** A chant checkout: core 2.0.0, a k8s lexicon on core, a fountain lexicon on k8s, and a private package. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-4787-checkout-"));
  write(join(dir, "package.json"), { name: "chant-monorepo", private: true, workspaces: ["packages/*", "lexicons/*"] });
  write(join(dir, "packages/core/package.json"), { name: "@intentius/chant", version: "2.0.0" });
  write(join(dir, "packages/internal/package.json"), { name: "internal", private: true });
  write(join(dir, "lexicons/k8s/package.json"), { name: "@intentius/chant-lexicon-k8s", version: "2.0.0", peerDependencies: { "@intentius/chant": "2.0.0" } });
  write(join(dir, "lexicons/fountain/package.json"), { name: "@intentius/chant-lexicon-fountain", version: "2.0.0", dependencies: { "@intentius/chant-lexicon-k8s": "2.0.0", yaml: "^2" } });
  return dir;
}

/** A product pinned to chant 1.0.0, at the root and in `packages/app`. */
function product(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-4787-product-"));
  write(join(dir, "package.json"), { name: "product", private: true, workspaces: ["packages/*"], devDependencies: { "@intentius/chant": "1.0.0", "@intentius/chant-lexicon-k8s": "1.0.0" } });
  write(join(dir, "packages/app/package.json"), { name: "@example/app", dependencies: { "@intentius/chant": "1.0.0" }, devDependencies: { esbuild: "^0.25.0" } });
  write(join(dir, "packages/notes.txt"), "not a package\n");
  write(join(dir, "package-lock.json"), '{\n  "name": "product",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n');
  return dir;
}

describe("the packages to pack (#4787)", () => {
  it("lists a checkout's public packages and orders them after what they depend on", () => {
    const pkgs = chantPackages(checkout());
    expect([...pkgs.keys()].sort()).toEqual(["@intentius/chant", "@intentius/chant-lexicon-fountain", "@intentius/chant-lexicon-k8s"]);
    expect(packOrder(pkgs, ["@intentius/chant-lexicon-fountain"]).map((p) => p.dir)).toEqual(["packages/core", "lexicons/k8s", "lexicons/fountain"]);
    expect(packOrder(pkgs, ["@intentius/chant"]).map((p) => p.name)).toEqual(["@intentius/chant"]);
  });

  it("refuses a package the checkout lacks, and a cycle", () => {
    const pkgs = chantPackages(checkout());
    expect(() => packOrder(pkgs, ["@intentius/chant-lexicon-nope"])).toThrow("the chant checkout has no package @intentius/chant-lexicon-nope");
    pkgs.get("@intentius/chant")!.deps.push("@intentius/chant-lexicon-k8s");
    expect(() => packOrder(pkgs, ["@intentius/chant"])).toThrow(LocalChantError);
  });

  it("reads the product's manifests and the chant packages they name", () => {
    const dir = product();
    expect(productManifests(dir)).toEqual(["package.json", "packages/app/package.json"]);
    expect(productChantNames(dir)).toEqual(["@intentius/chant", "@intentius/chant-lexicon-k8s"]);
  });

  it("points a manifest at the tarballs, and the root at every one", () => {
    const local = new Map([["@intentius/chant", "file:/t/a.tgz"], ["@intentius/chant-lexicon-k8s", "file:/t/b.tgz"]]);
    const app = pointAtTarballs({ dependencies: { "@intentius/chant": "1.0.0", other: "1" } }, local, false);
    expect(app).toEqual({ dependencies: { "@intentius/chant": "file:/t/a.tgz", other: "1" } });
    const root = pointAtTarballs({ dependencies: { "@intentius/chant": "1.0.0" } }, local, true);
    expect(root).toEqual({ dependencies: { "@intentius/chant": "file:/t/a.tgz" }, devDependencies: { "@intentius/chant-lexicon-k8s": "file:/t/b.tgz" } });
  });
});

/** A runner standing in for npm: pack writes a versioned tarball; install copies each `file:` dependency the manifests name into node_modules. */
function fakeNpm(seen: { manifests?: string[]; calls: string[] }, opts: { installVersion?: string } = {}): Runner {
  return (command, args, cwd) => {
    seen.calls.push(`${command} ${args[0]} ${basename(cwd)}`);
    if (args[0] === "pack") {
      const p = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      const file = `${p.name.replace(/^@/, "").replace("/", "-")}-${p.version}.tgz`;
      writeFileSync(join(args[args.indexOf("--pack-destination") + 1], file), "tgz");
      return `${file}\n`;
    }
    if (args[0] === "install") {
      seen.manifests = productManifests(cwd).map((f) => readFileSync(join(cwd, f), "utf8"));
      for (const f of productManifests(cwd)) {
        const p = JSON.parse(readFileSync(join(cwd, f), "utf8"));
        for (const [name, spec] of Object.entries({ ...p.dependencies, ...p.devDependencies } as Record<string, string>)) {
          if (!spec.startsWith("file:")) continue;
          const at = join(cwd, f === "package.json" ? "" : dirname(f), "node_modules", name);
          write(join(at, "package.json"), { name, version: opts.installVersion ?? "2.0.0" });
        }
      }
      // npm writes the lock unless --no-save; the restore must undo it either way.
      writeFileSync(join(cwd, "package-lock.json"), "changed\n");
      return "";
    }
    return "";
  };
}

describe("installLocalChant (#4787)", () => {
  it("packs, installs with --no-save, puts the manifests and lock back byte for byte, and marks each copy", () => {
    const chant = checkout();
    const dir = product();
    const before = ["package.json", "packages/app/package.json", "package-lock.json"].map((f) => readFileSync(join(dir, f), "utf8"));
    const seen: { manifests?: string[]; calls: string[] } = { calls: [] };
    const r = installLocalChant({ productDir: dir, chantDir: chant, install: false, run: fakeNpm(seen), log: () => {} });

    expect(r.packed.map((p) => p.dir)).toEqual(["packages/core", "lexicons/k8s"]);
    expect(seen.calls).toEqual(["npm pack core", "npm pack k8s", `npm install ${basename(dir)}`]);
    expect(existsSync(join(dir, ".chant-local/intentius-chant.tgz"))).toBe(true);
    expect(existsSync(join(dir, ".chant-local/intentius-chant-2.0.0.tgz"))).toBe(false);
    // During the install every manifest named the tarballs.
    expect(seen.manifests![0]).toContain(`"@intentius/chant": "file:${join(dir, ".chant-local/intentius-chant.tgz")}"`);
    expect(seen.manifests![1]).toContain(`"@intentius/chant": "file:${join(dir, ".chant-local/intentius-chant.tgz")}"`);
    expect(["package.json", "packages/app/package.json", "package-lock.json"].map((f) => readFileSync(join(dir, f), "utf8"))).toEqual(before);

    expect(r.marked).toBe(3);
    const core = JSON.parse(readFileSync(join(dir, "packages/app/node_modules/@intentius/chant/package.json"), "utf8"));
    expect(core.chantLocal).toEqual({ commit: r.mark.commit, dir: chant });
    expect(JSON.parse(readFileSync(join(dir, ".chant-local/packages.json"), "utf8")).map((p: { name: string }) => p.name)).toEqual(["@intentius/chant", "@intentius/chant-lexicon-k8s"]);
  });

  it("packs a --with package and its chant dependencies", () => {
    const seen = { calls: [] as string[] };
    const r = installLocalChant({ productDir: product(), chantDir: checkout(), with: ["@intentius/chant-lexicon-fountain"], install: false, run: fakeNpm(seen), log: () => {} });
    expect(r.packed.map((p) => p.name)).toEqual(["@intentius/chant", "@intentius/chant-lexicon-k8s", "@intentius/chant-lexicon-fountain"]);
  });

  it("puts the manifests back when the install fails", () => {
    const dir = product();
    const before = readFileSync(join(dir, "package.json"), "utf8");
    const npm = fakeNpm({ calls: [] });
    const failing: Runner = (c, a, cwd) => {
      if (a[0] === "install") throw new LocalChantError("npm install exited 1");
      return npm(c, a, cwd);
    };
    expect(() => installLocalChant({ productDir: dir, chantDir: checkout(), install: false, run: failing, log: () => {} })).toThrow("npm install exited 1");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
  });

  it("fails when an installed copy is not the checkout's version", () => {
    const run = fakeNpm({ calls: [] }, { installVersion: "1.0.0" });
    expect(() => installLocalChant({ productDir: product(), chantDir: checkout(), install: false, run, log: () => {} })).toThrow(/is 1\.0\.0, the checkout's is 2\.0\.0/);
  });

  it("runs npm ci in the checkout only when its lock changed", () => {
    const chant = checkout();
    write(join(chant, "package-lock.json"), "{}\n");
    mkdirSync(join(chant, "node_modules"), { recursive: true });
    const seen = { calls: [] as string[] };
    installLocalChant({ productDir: product(), chantDir: chant, run: fakeNpm(seen), log: () => {} });
    installLocalChant({ productDir: product(), chantDir: chant, run: fakeNpm(seen), log: () => {} });
    expect(seen.calls.filter((c) => c.startsWith("npm ci"))).toHaveLength(1);
  });

  it("refuses a directory that is not a chant checkout", () => {
    expect(() => installLocalChant({ productDir: product(), chantDir: tmpdir(), install: false, log: () => {} })).toThrow("is not a chant checkout");
  });
});

describe("lockMismatches (#4787)", () => {
  it("names a copy off the lock and a local build", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-4787-reset-"));
    write(join(dir, "package-lock.json"), { packages: { "node_modules/@intentius/chant": { version: "1.0.0" }, "node_modules/@intentius/chant-lexicon-k8s": { version: "1.0.0" }, "node_modules/left-pad": { version: "1.0.0" } } });
    write(join(dir, "node_modules/@intentius/chant/package.json"), { version: "1.0.0" });
    write(join(dir, "node_modules/@intentius/chant-lexicon-k8s/package.json"), { version: "1.0.0", chantLocal: { commit: "abc", dir: "/c" } });
    expect(lockMismatches(dir)).toEqual(["node_modules/@intentius/chant-lexicon-k8s is 1.0.0 (local build), the lock says 1.0.0"]);
  });
});
