// Diff two catalogs by name per section: what a pin move would show up as.
import { readFileSync } from "node:fs";
const [a, b] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, "utf8")));
const names = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : x.name)) : []);
console.log(`${a.version} -> ${b.version}`);
for (const k of Object.keys(a)) {
  if (!Array.isArray(a[k])) continue;
  const A = new Set(names(a[k])), B = new Set(names(b[k]));
  const add = [...B].filter((x) => !A.has(x)), rem = [...A].filter((x) => !B.has(x));
  if (add.length || rem.length) console.log(`${k}: +${add.length} -${rem.length}  +[${add.slice(0, 6)}${add.length > 6 ? ",..." : ""}] -[${rem.slice(0, 6)}${rem.length > 6 ? ",..." : ""}]`);
}
