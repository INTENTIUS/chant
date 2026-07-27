// Exhibit renderer (chant #1104's input): turn the two committed captures into static
// timeline SVGs using spicypath's headless renderers — package-attributed colors,
// search-dim on the estate's own source files, and a derived marker at the first
// project frame. The CDK exhibit gets a marker near t=0; the chant exhibit has no
// project frame to mark, and its title says so — that asymmetry is the argument.
//
//   node exhibits/render.mjs /path/to/spicypath
//
// spicypath is a sibling tool (https://github.com/INTENTIUS/spicypath), pinned by the
// ref recorded in results/analysis metadata when the exhibits were last regenerated.
// Needs Node >= 23.6 (spicypath's own harness baseline; type-stripping).

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const spicy = process.argv[2];
if (!spicy) {
  console.error("usage: node exhibits/render.mjs /path/to/spicypath");
  process.exit(1);
}
const sp = async (p) => import(pathToFileURL(resolve(spicy, p)).href);

const { parseCpuProfileText } = await sp("src/parse-cpuprofile.js");
const { buildFlameChart, chartLayout, firstMatchTime } = await sp("src/flamechart.js");
const { renderSVG } = await sp("src/render-svg.js");

const W = 1400;

function render(capture, outName, title, projectFilePredicate) {
  const p = parseCpuProfileText(readFileSync(capture, "utf8"));
  const chart = buildFlameChart(p, 0);
  const boxes = chartLayout(chart, p, { width: W, minWidth: 0.5 });

  // Search-dim: light exactly the funcs whose FILE is the estate's own source — the same
  // question the analyzer asks, rendered instead of counted.
  const matched = new Set();
  for (let f = 0; f < p.funcTable.name.length; f++) {
    const fi = p.funcTable.file[f];
    const file = fi >= 0 ? (p.stringTable[fi] || "") : "";
    if (projectFilePredicate(file)) matched.add(f);
  }

  const mt = firstMatchTime(chart, p, matched);
  const px = W / (chart.end - chart.start);
  const markers = mt != null ? [{ x: (mt - chart.start) * px, label: "first project frame" }] : [];
  const suffix = mt != null
    ? `${matched.size} project fns · first project frame marked`
    : `0 project fns matched — no project frame exists to mark`;

  writeFileSync(`exhibits/${outName}`, renderSVG(boxes, p, { width: W, title: `${title} · ${suffix}`, matched, markers }));
  console.log(`   exhibits/${outName} — ${boxes.length} boxes, ${matched.size} project fns, marker=${mt != null}`);
}

render(
  "captures/cdk-app.cpuprofile",
  "cdk-synth.svg",
  "cdk synth (app subprocess) — timeline",
  (f) => f.includes("/cdk-app/") && !f.includes("/node_modules/"),
);
render(
  "captures/chant-build.cpuprofile",
  "chant-build-fold.svg",
  "chant build --fold — timeline",
  (f) => f.includes("/chant-app/") && !f.includes("/node_modules/"),
);
