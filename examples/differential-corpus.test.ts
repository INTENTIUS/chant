import { describe, expect, test } from "vitest";
import { discoverCorpus } from "./differential-corpus";

/**
 * chant #1996 — the corpus discovery itself, not just the differentials that
 * consume it. `discoverCorpus()` used to force `lexicons: [<the directory's
 * own lexicon>]` for every `lexicons/*<dot>/examples/*<dot>/src` fixture,
 * ignoring what that fixture's OWN `chant.config.ts` declares — so a fixture
 * opting a second lexicon in (`lexicons/helm/examples/stateful-service`
 * declares `["helm", "k8s"]`) was measured with a narrower allowlist than a
 * real `chant build` for that directory grants, understating what
 * `--sandbox`'s active-lexicon trust boundary (chant #1093) actually allows.
 *
 * These assertions are deliberately narrow and fast — no build, just what
 * `CorpusEntry.lexicons` (and the serializers/intrinsics/plugins derived from
 * it) came back as — so a regression here is caught without paying the full
 * `fold-differential`/`sandbox-differential` corpus-build cost.
 */
describe("discoverCorpus — a lexicons/*/examples/* fixture's own declared lexicons (chant #1996)", () => {
  test("a fixture declaring a SECOND lexicon in its own chant.config.ts gets both, not just its directory's", async () => {
    const corpus = await discoverCorpus();
    const entry = corpus.find((e) => e.name === "lexicons/helm/examples/stateful-service");

    expect(entry).toBeDefined();
    if (!entry) return;
    // `lexicons/helm/examples/stateful-service/chant.config.ts` declares
    // exactly `["helm", "k8s"]` — the harness must reproduce that, not
    // silently narrow it to `["helm"]` because of which directory it lives
    // under.
    expect(entry.lexicons).toEqual(["helm", "k8s"]);
    expect(entry.serializers.length).toBe(2);
    expect(entry.plugins.length).toBe(2);
  });

  test("a fixture that declares only its own directory's lexicon is unaffected", async () => {
    const corpus = await discoverCorpus();
    const cronJob = corpus.find((e) => e.name === "lexicons/helm/examples/cron-job");
    const multiContainer = corpus.find((e) => e.name === "lexicons/helm/examples/multi-container");

    expect(cronJob?.lexicons).toEqual(["helm"]);
    expect(multiContainer?.lexicons).toEqual(["helm"]);
  });
});
