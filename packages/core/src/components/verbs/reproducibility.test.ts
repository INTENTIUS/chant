import { describe, expect, it } from "vitest";
import { defaultReproducibility } from "./reproducibility";

describe("defaultReproducibility (#614)", () => {
  it("a template (synthesized IaC) entry defaults to deterministic-synthesis, verifiable by re-synth", () => {
    expect(defaultReproducibility("template")).toEqual({ basis: "deterministic-synthesis", verifyBy: "re-synth" });
  });

  it("an image entry defaults to best-effort, with no verification method claimed", () => {
    expect(defaultReproducibility("image")).toEqual({ basis: "best-effort" });
  });

  it("an asset entry (jar/zip) defaults to best-effort, same as image — an externally-built artifact either way", () => {
    expect(defaultReproducibility("asset")).toEqual({ basis: "best-effort" });
  });

  it("an sbom entry gets no reproducibility claim of its own — it describes another artifact, it isn't one", () => {
    expect(defaultReproducibility("sbom")).toBeUndefined();
  });

  it("never gives an image the same basis claim as a template — the honest-per-artifact-type distinction #614 requires", () => {
    expect(defaultReproducibility("image")!.basis).not.toBe(defaultReproducibility("template")!.basis);
  });
});
