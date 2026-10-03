// Compare the catalogs of several majors: node diff.mjs <outroot> <tag>...
import { readFileSync } from "node:fs";
const [root, ...tags] = process.argv.slice(2);
const cat = Object.fromEntries(tags.map((t) => [t, JSON.parse(readFileSync(`${root}/${t}/postgres-catalog.json`, "utf8"))]));
const sections = {
  types: (c) => c.types.filter((t) => t.kind !== "p").map((t) => t.name),
  accessMethods: (c) => c.accessMethods.map((a) => `${a.type}:${a.name}`),
  opclasses: (c) => c.opclasses.map((o) => `${o.am}/${o.name}/${o.inputType}`),
  functions: (c) => c.functions.map((f) => f.name),
  operators: (c) => c.operators.map((o) => o.name),
  settings: (c) => c.settings.map((s) => s.name),
  keywords: (c) => c.keywords.map((k) => `${k.word}:${k.code}`),
  extensions: (c) => c.extensions.map((e) => e.name),
  storage: (c) => Object.entries(c.storageParameters).flatMap(([t, ns]) => ns.map((n) => `${t}.${n}`)),
};
const sets = (tag) => Object.fromEntries(Object.entries(sections).map(([k, f]) => [k, new Set(f(cat[tag]))]));
const S = Object.fromEntries(tags.map((t) => [t, sets(t)]));
console.log("counts");
console.log(["section", ...tags].join("\t"));
for (const k of Object.keys(sections)) console.log([k, ...tags.map((t) => S[t][k].size)].join("\t"));
const extra = { arrayTypes: "arrayTypeCount", compositeTypes: "compositeTypeCount", procRows: "functionRowCount" };
for (const [l, k] of Object.entries(extra)) console.log([l, ...tags.map((t) => cat[t][k])].join("\t"));
const show = process.env.SHOW ? Number(process.env.SHOW) : 12;
function pair(a, b) {
  console.log(`\n== ${a} -> ${b}`);
  for (const k of Object.keys(sections)) {
    const add = [...S[b][k]].filter((x) => !S[a][k].has(x)).sort();
    const del = [...S[a][k]].filter((x) => !S[b][k].has(x)).sort();
    if (!add.length && !del.length) continue;
    console.log(`${k}: +${add.length} -${del.length}`);
    if (add.length) console.log("  +", add.slice(0, show).join(" ") + (add.length > show ? " ..." : ""));
    if (del.length) console.log("  -", del.slice(0, show).join(" ") + (del.length > show ? " ..." : ""));
  }
  // settings whose type or enum members moved
  const bys = (t) => Object.fromEntries(cat[t].settings.map((s) => [s.name, s]));
  const A = bys(a), B = bys(b); const chg = [];
  for (const n of Object.keys(A)) if (B[n] && (A[n].type !== B[n].type || JSON.stringify(A[n].enumvals) !== JSON.stringify(B[n].enumvals))) chg.push(n);
  if (chg.length) console.log(`settings with changed type or enum members: ${chg.length}: ${chg.slice(0, show).join(" ")}`);
}
for (let i = 0; i < tags.length - 1; i++) pair(tags[i], tags[i + 1]);
if (tags.length > 2) { pair(tags[0], tags.find((t) => t.startsWith("18")) ?? tags.at(-1)); }
