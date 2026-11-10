import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * #4787 end to end: `chant dev local <checkout>` through the real CLI, with
 * real `npm pack` and `npm install`, on a fixture checkout and a fixture
 * product. Nothing reaches a registry: every chant package comes from a
 * tarball and the fixtures have no other dependencies.
 */

const here = dirname(fileURLToPath(import.meta.url));
const mainTs = resolve(here, "cli/main.ts");
/**
 * tsx's loader by path, under plain node: the fixtures sit outside the
 * worktree, where npx would look tsx up again, and the tsx command's IPC
 * socket in a long TMPDIR passes the socket path limit.
 */
const tsxLoader = pathToFileURL(resolve(here, "../../../node_modules/tsx/dist/loader.mjs")).href;

const write = (file: string, body: string | object) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
};

/** A chant checkout whose core and k8s lexicon are already built (dist/ in place, no prepack); `next` writes a NEXT_RELEASE into its release-floors.ts. */
function checkout(next?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-4787-e2e-checkout-"));
  write(join(dir, "package.json"), { name: "chant-monorepo", private: true, workspaces: ["packages/*", "lexicons/*"] });
  write(join(dir, "packages/core/package.json"), { name: "@intentius/chant", version: "2.0.0", type: "module", files: ["dist/"], exports: { ".": { import: "./dist/index.js" } } });
  write(join(dir, "packages/core/dist/index.js"), "export const local = true;\n");
  write(join(dir, "lexicons/k8s/package.json"), { name: "@intentius/chant-lexicon-k8s", version: "2.0.0", type: "module", files: ["dist/"], exports: { ".": { default: "./dist/index.js" } }, peerDependencies: { "@intentius/chant": "2.0.0" } });
  write(join(dir, "lexicons/k8s/dist/index.js"), "export {};\n");
  if (next) write(join(dir, "packages/core/src/release-floors.ts"), `export const NEXT_RELEASE = "${next}";\n`);
  // A lock for the checkout's npm ci: workspaces only, so npm writes it offline.
  const lock = spawnSync("npm", ["install", "--package-lock-only", "--offline", "--no-audit", "--no-fund"], { cwd: dir, encoding: "utf8" });
  if (lock.status !== 0) throw new Error(`npm install --package-lock-only: ${lock.stderr}`);
  return dir;
}

/** A product pinned to chant 2.0.0 whose `packages/app` bundle imports chant core. */
function product(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-4787-e2e-product-"));
  write(join(dir, "package.json"), { name: "product", private: true, workspaces: ["packages/*"], devDependencies: { "@intentius/chant": "2.0.0", "@intentius/chant-lexicon-k8s": "2.0.0" } });
  write(join(dir, "packages/app/package.json"), {
    name: "@example/app",
    version: "0.1.0",
    dependencies: { "@intentius/chant": "2.0.0" },
    devDependencies: { "@intentius/chant-lexicon-k8s": "2.0.0" },
    chantBundleCheck: { bundle: "dist/app.mjs", maxBytes: 4096 },
  });
  write(join(dir, "package-lock.json"), '{\n  "name": "product",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {}\n}\n');
  return dir;
}

const chant = (cwd: string, ...args: (string | { env: Record<string, string> })[]) => {
  const extra = args.find((a): a is { env: Record<string, string> } => typeof a !== "string");
  const argv = args.filter((a): a is string => typeof a === "string");
  return spawnSync(process.execPath, ["--import", tsxLoader, mainTs, ...argv], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", npm_config_offline: "true", ...extra?.env }, timeout: 110_000 });
};

describe("chant dev local (#4787)", () => {
  it("packs a checkout into a product, keeps its manifests and lock, builds, and checks the bundle", () => {
    const repo = checkout();
    const dir = product();
    const files = ["package.json", "packages/app/package.json", "package-lock.json"];
    const before = files.map((f) => readFileSync(join(dir, f), "utf8"));
    const build = "mkdir -p packages/app/dist && printf 'import { local } from \"@intentius/chant\";\\nconsole.log(local);\\n' > packages/app/dist/app.mjs";

    const r = chant(dir, "dev", "local", repo, "--build", build);
    expect(r.stderr).toContain("bundle-check: @example/app");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("chant commit:");
    expect(files.map((f) => readFileSync(join(dir, f), "utf8"))).toEqual(before);

    const core = JSON.parse(readFileSync(join(dir, "node_modules/@intentius/chant/package.json"), "utf8"));
    expect(core.version).toBe("2.0.0");
    expect(core.chantLocal.dir).toBe(repo);
    const lexicon = JSON.parse(readFileSync(join(dir, "node_modules/@intentius/chant-lexicon-k8s/package.json"), "utf8"));
    expect(lexicon.chantLocal).toBeDefined();

    // The bundle check on its own, and one that fails: an import the installed chant does not serve.
    expect(chant(dir, "dev", "bundle-check", "packages/app").status).toBe(0);
    writeFileSync(join(dir, "packages/app/dist/app.mjs"), 'import "@intentius/chant/missing";\n');
    const bad = chant(dir, "dev", "bundle-check");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("'@intentius/chant/missing', which the installed package's exports do not serve as compiled JS");
  }, 120_000);

  it("refuses a usage without a checkout", () => {
    const r = chant(product(), "dev", "local");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("chant dev local needs a chant checkout");
  }, 60_000);

  it("keeps a dev dependency's peers and installs the checkout at its next release (#4921)", async () => {
    const repo = checkout("2.1.0");
    const dir = product();
    // A test runner whose peer (vitest's vite, say) npm installs from the registry.
    const vendor = join(dir, "vendor/tester");
    write(join(vendor, "package.json"), { name: "tester", version: "1.0.0", peerDependencies: { helper: "^1.0.0" } });
    const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", join(dir, "vendor")], { cwd: vendor, encoding: "utf8" });
    expect(packed.status).toBe(0);
    const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    root.devDependencies.tester = "file:vendor/tester-1.0.0.tgz";
    write(join(dir, "package.json"), root);
    const registry = await startRegistry(dir);
    try {
      const env = { npm_config_registry: registry.url, npm_config_offline: "false" };
      const build = "mkdir -p packages/app/dist && printf 'import { local } from \"@intentius/chant\";\\n' > packages/app/dist/app.mjs";
      const r = chant(dir, "dev", "local", repo, "--build", build, "--json", { env });
      expect(r.stderr).not.toContain("ERESOLVE");
      expect(r.status).toBe(0);
      expect(existsSync(join(dir, "node_modules/helper/package.json"))).toBe(true);

      const core = JSON.parse(readFileSync(join(dir, "node_modules/@intentius/chant/package.json"), "utf8"));
      expect(core.version).toBe("2.1.0");
      const lexicon = JSON.parse(readFileSync(join(dir, "node_modules/@intentius/chant-lexicon-k8s/package.json"), "utf8"));
      expect(lexicon.version).toBe("2.1.0");
      expect(lexicon.peerDependencies["@intentius/chant"]).toBe("2.1.0");
      const out = JSON.parse(r.stdout);
      expect(out.local.packed).toEqual([
        { name: "@intentius/chant", version: "2.1.0" },
        { name: "@intentius/chant-lexicon-k8s", version: "2.1.0" },
      ]);
    } finally {
      registry.stop();
    }
  }, 120_000);
});

/** A registry on localhost, in its own process, that serves `helper` 1.0.0. */
async function startRegistry(dir: string): Promise<{ url: string; stop: () => void }> {
  const helper = join(dir, "vendor/helper");
  write(join(helper, "package.json"), { name: "helper", version: "1.0.0" });
  const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", join(dir, "vendor")], { cwd: helper, encoding: "utf8" });
  if (packed.status !== 0) throw new Error(`npm pack helper: ${packed.stderr}`);
  const server = join(dir, "vendor/registry.mjs");
  write(
    server,
    `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const tgz = readFileSync(${JSON.stringify(join(dir, "vendor/helper-1.0.0.tgz"))});
const s = createServer((req, res) => {
  const base = "http://127.0.0.1:" + s.address().port;
  if (req.url === "/helper") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name: "helper", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "helper", version: "1.0.0", dist: { tarball: base + "/helper-1.0.0.tgz", shasum: createHash("sha1").update(tgz).digest("hex") } } } }));
  } else if (req.url === "/helper-1.0.0.tgz") {
    res.end(tgz);
  } else {
    res.statusCode = 404;
    res.end("{}");
  }
});
s.listen(0, "127.0.0.1", () => console.log(s.address().port));
`,
  );
  const child = spawn(process.execPath, [server], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((ok, fail) => {
    child.stdout.once("data", (b: Buffer) => ok(b.toString().trim()));
    child.once("exit", (code) => fail(new Error(`the registry exited ${code}`)));
  });
  return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() };
}
