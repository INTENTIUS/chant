// One measurement, applied identically to both captures (chant #1084).
//
// A .cpuprofile records which functions were on a sampled stack. Two things are derived
// from each capture, with the boundary definitions below stated precisely enough to argue
// with:
//
// 1. PROJECT-CODE BOOLEAN — did any frame from the estate's own source files execute?
//    "Project" = a file inside the estate directory that is not under node_modules.
//    This is the honest form of the headline (see #1084's correction comment): a profile
//    cannot say what fraction of the graph was known at time T, but it can say whether
//    the tool ever ran your code at all. Sampling can only miss frames, never invent
//    them — so a "yes" is definitive, and the chant side's "no" is additionally pinned
//    by a hard, unsampled invariant: capture.sh fails unless every file reported
//    [fold:fold] (zero module execution, enforced by the build itself).
//
// 2. TRUSTED-COMPUTING-BASE BYTES — bytes of distinct third-party files observed
//    executing (every node_modules file appearing in the capture, byte size on disk,
//    each file counted once). Split two ways per tool, and the split is NOT hand-curated:
//    each estate's package.json declares exactly one kind of dependency, so every
//    observed third-party package inherits that estate's role.
//      - chant-app declares only the SYNTHESIZER (@intentius/chant + lexicon); tsx,
//        typescript, zod, js-yaml etc. are its transitive machinery. The CDK CLI never
//        appears on the other side because the app subprocess is what's profiled.
//      - cdk-app declares only the DEFINITION LIBRARY (aws-cdk-lib + constructs);
//        minimatch, semver, @aws-cdk/* are its transitive closure — code that runs
//        BECAUSE the project's definitions run.
//    Both tools execute machinery; only one must execute the project's definition
//    graph to know what it builds. That asymmetry is what the split shows.
//
// Timing is deliberately absent from the output (#1084's non-goal: not a benchmark).

import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = resolve(".");

// Per-tool boundary config. `role` is the classification every observed third-party
// package inherits — it follows from what the estate's package.json declares (see the
// module doc above), not from a curated allowlist.
const TOOLS = {
  chant: {
    capture: "captures/chant-build.cpuprofile",
    estate: resolve("chant-app"),
    role: "synthesizer",
  },
  cdk: {
    capture: "captures/cdk-app.cpuprofile",
    estate: resolve("cdk-app"),
    role: "definition-library",
  },
};

function stripFileUrl(u) {
  return u.startsWith("file://") ? decodeURIComponent(u.slice("file://".length)) : u;
}

// Innermost node_modules segment → package name (@scope kept with its name).
function packageOf(path) {
  const segs = path.split("/");
  const nm = segs.lastIndexOf("node_modules");
  if (nm < 0 || !segs[nm + 1]) return null;
  const pkg = segs[nm + 1];
  return pkg.startsWith("@") && segs[nm + 2] ? `${pkg}/${segs[nm + 2]}` : pkg;
}

function analyze(name, cfg) {
  const prof = JSON.parse(readFileSync(cfg.capture, "utf8"));
  const files = new Set();
  for (const n of prof.nodes) {
    const url = n.callFrame?.url;
    if (url) files.add(stripFileUrl(url));
  }

  const projectFiles = [];
  const thirdParty = new Map(); // package → { files: Set, bytes }
  let nodeInternal = 0;

  for (const f of files) {
    if (f.startsWith("node:")) { nodeInternal++; continue; }
    const pkg = packageOf(f);
    if (pkg) {
      let e = thirdParty.get(pkg);
      if (!e) thirdParty.set(pkg, (e = { files: new Set(), bytes: 0 }));
      if (!e.files.has(f)) {
        e.files.add(f);
        try { e.bytes += statSync(f).size; } catch { /* sanitized/relocated capture: bytes need a live tree */ }
      }
      continue;
    }
    if (f.startsWith(cfg.estate + "/") || f === join(cfg.estate, "app.js")) projectFiles.push(f);
  }

  const total = [...thirdParty.values()].reduce((a, e) => a + e.bytes, 0);
  const pkgTable = [...thirdParty.entries()]
    .map(([pkg, e]) => ({ pkg, files: e.files.size, bytes: e.bytes, role: cfg.role }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    tool: name,
    capture: cfg.capture,
    projectCodeExecuted: projectFiles.length > 0,
    projectFilesObserved: projectFiles.map((f) => f.slice(cfg.estate.length + 1)).sort(),
    trustedComputingBase: {
      synthesizerBytes: cfg.role === "synthesizer" ? total : 0,
      definitionLibraryBytes: cfg.role === "definition-library" ? total : 0,
      packages: pkgTable,
    },
    nodeInternalModulesObserved: nodeInternal,
  };
}

const results = {};
for (const [name, cfg] of Object.entries(TOOLS)) results[name] = analyze(name, cfg);

// The chant side's boolean must agree with the fold log's hard invariant.
const foldLog = readFileSync("results/chant-build.log", "utf8");
const foldRuns = (foldLog.match(/\[fold:run\]/g) || []).length;
results.invariants = {
  chantFoldRunCount: foldRuns,
  agreement: results.chant.projectCodeExecuted === false && foldRuns === 0
    ? "capture and fold log agree: zero project-code execution on the chant side"
    : "DISAGREEMENT — investigate before trusting either number",
};

writeFileSync("results/analysis.json", JSON.stringify(results, null, 2) + "\n");

const mb = (b) => (b / 1024 / 1024).toFixed(2) + " MB";
console.log("\n  measurement                     chant                cdk");
console.log(`  project code executed           ${String(results.chant.projectCodeExecuted).padEnd(20)} ${results.cdk.projectCodeExecuted}`);
console.log(`  definition-library TCB          ${mb(results.chant.trustedComputingBase.definitionLibraryBytes).padEnd(20)} ${mb(results.cdk.trustedComputingBase.definitionLibraryBytes)}`);
console.log(`  synthesizer TCB                 ${mb(results.chant.trustedComputingBase.synthesizerBytes).padEnd(20)} ${mb(results.cdk.trustedComputingBase.synthesizerBytes)}`);
console.log(`  ${results.invariants.agreement}\n`);
if (results.chant.projectCodeExecuted) {
  console.error("FAIL: project frames observed in the chant capture:", results.chant.projectFilesObserved);
  process.exit(1);
}
if (!results.cdk.projectCodeExecuted) {
  console.error("FAIL: no project frames in the CDK capture — the app was not what got profiled.");
  process.exit(1);
}
