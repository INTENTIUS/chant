/**
 * The keys an author types for this lexicon: the `decide` step's options and
 * the `systemone` config namespace. Completions and hover read this table.
 */

export interface OptionKey {
  key: string;
  detail: string;
}

export const DECIDE_KEYS: OptionKey[] = [
  { key: "inputs", detail: "Input values by the point's input names, such as { \"work-item.fits_small\": false }. They win over values read with `read`." },
  { key: "read", detail: "What to read through the read contract, by output: { \"work-item\": \"W-002\" } reads work item W-002 for every work-item.* input. Reads record, decision, work-item and member." },
  { key: "subject", detail: "What the question is about, such as a work item's id. Written to the answer's constrains." },
  { key: "kind", detail: "The answer kind file, or a declared kind's name. Without it, the declared answer kind whose points file declares the point." },
  { key: "cwd", detail: "Where the workspace is found. Defaults to the working directory." },
  { key: "backends", detail: "Backends by name, in place of systemone.backends in chant.config." },
  { key: "dryRun", detail: "Ask, but write nothing." },
];

export const CONFIG_KEYS: OptionKey[] = [{ key: "backends", detail: "Backend name, as a point's model decider names it, to { url, key?, timeoutMs? }." }];

export const BACKEND_KEYS: OptionKey[] = [
  { key: "url", detail: "The server's base URL. /v1/systemone is appended." },
  { key: "key", detail: "Where the bearer key comes from: { env: \"VARIABLE\" } or a brokered capability { capability, member?, env? }. Never a literal (SYS001)." },
  { key: "timeoutMs", detail: "How long to wait before the backend counts as unreachable, in milliseconds. Default 30000." },
];

export const KEY_KEYS: OptionKey[] = [
  { key: "env", detail: "The environment variable holding the key, or, with a capability, the one the broker sets." },
  { key: "capability", detail: "A capability a box member declares as brokered (box.capabilities in chant.workspace.json)." },
  { key: "member", detail: "The member whose box declares the capability. Without it, the one member that declares it." },
];

export const ALL_KEYS = new Map<string, string>([...DECIDE_KEYS, ...CONFIG_KEYS, ...BACKEND_KEYS, ...KEY_KEYS].map((k) => [k.key, k.detail]));
