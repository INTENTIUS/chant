/**
 * The soak's sources in a job (#5326): HTTP through `fetch`, commands
 * through `spawnSync`, `lifecycle health` through the product's bin, the
 * applies and policy denials from the op's run records on `chant/lifecycle`,
 * and the drift issue from the forge the job runs on. A source that cannot
 * be reached reads `unknown`, which holds.
 */

import { activeProductWords } from "../ci-product-words";
import { driftIssueMarker } from "../drift-issue";
import { readRunLedger } from "../lifecycle/run-ledger";
import { opWaveBinArgv } from "../op/op-waves";
import { forgeClient, forgeTargetFromEnv } from "../pr-forge";
import { runRecordSoakSources, spawnSoakExec, type SoakSources } from "./soak-checks";

export interface JobSoakSourcesOptions {
  /** The op whose run records hold the applies and denials. */
  op: string;
  /** The member's directory, where commands and `lifecycle health` run. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** The sources a promote or a wave job reads its soak's checks from. */
export function jobSoakSources(options: JobSoakSourcesOptions): SoakSources {
  const words = activeProductWords();
  const env = options.env ?? process.env;
  const records = new Map<string, Promise<ReturnType<typeof runRecordSoakSources>>>();
  const ledger = (environment: string) => {
    let got = records.get(environment);
    if (!got) {
      got = readRunLedger(environment, options.op, { cwd: options.cwd }).then((r) => runRecordSoakSources(r.records));
      records.set(environment, got);
    }
    return got;
  };
  return {
    fetch: async (url, init) => {
      const res = await globalThis.fetch(url, { ...(init.signal ? { signal: init.signal } : {}), ...(init.headers ? { headers: init.headers } : {}) });
      return { status: res.status, text: () => res.text() };
    },
    exec: spawnSoakExec(options.cwd),
    healthCommand: (environment) => [...opWaveBinArgv(words.bin), "lifecycle", "health", environment, "--json"],
    applies: async (environment, member, targets) => (await ledger(environment)).applies!(environment, member, targets),
    denials: async (environment, member, targets) => (await ledger(environment)).denials!(environment, member, targets),
    driftIssue: async (environment) => {
      const forge = forgeClient(forgeTargetFromEnv(env));
      const issue = await forge.findIssue(driftIssueMarker(words.product, environment));
      return issue ? { body: issue.body, ...(issue.url ? { url: issue.url } : {}) } : null;
    },
  };
}
