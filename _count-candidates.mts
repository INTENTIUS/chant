// Run BFS with no cap to count ALL candidate files, then also
// validate the 40 by checking each path matches isCandidatePath.
import { isCandidatePath } from "./packages/core/src/audit/discover.ts";

const PROJECT = "gitlab-org%2Fgitlab";
const REF = "master";
const API = "https://gitlab.com/api/v4";

const allCandidates: string[] = [];
const queue: string[] = [""];
const visited = new Set<string>();
let apiCalls = 0;

while (queue.length > 0) {
  const dir = queue.shift()!;
  if (visited.has(dir)) continue;
  visited.add(dir);
  const pathParam = dir ? `&path=${encodeURIComponent(dir)}` : "";
  for (let page = 1; page <= 5; page++) {
    const url = `${API}/projects/${PROJECT}/repository/tree?per_page=100&page=${page}&ref=${REF}${pathParam}`;
    apiCalls++;
    const res = await fetch(url, { headers: { "User-Agent": "chant-audit-test" } });
    const body = await res.json() as Array<{ path: string; type: string }>;
    if (!Array.isArray(body) || body.length === 0) break;
    for (const e of body) {
      if (e.type === "blob" && isCandidatePath(e.path)) allCandidates.push(e.path);
      else if (e.type === "tree") queue.push(e.path);
    }
    if (body.length < 100) break;
  }
  // rate-limit guard
  if (apiCalls % 10 === 0) process.stdout.write(`\r  ${apiCalls} API calls, ${visited.size} dirs visited, ${allCandidates.length} candidates so far...`);
}

console.log(`\n\nTotal dirs visited : ${visited.size}`);
console.log(`Total API calls    : ${apiCalls}`);
console.log(`Total candidates   : ${allCandidates.length}`);
console.log(`\nFirst 20 candidates:`);
allCandidates.slice(0, 20).forEach(p => console.log(" ", p));
