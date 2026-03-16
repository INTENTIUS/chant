/**
 * HelmLibrary composite — Library chart (type: library, no templates).
 *
 * Produces a Helm library chart with only Chart.yaml and _helpers.tpl.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Chart, Values } from "../resources";

export interface HelmLibraryProps {
  /** Chart name. */
  name: string;
  /** Chart version. */
  version?: string;
  /** Chart description. */
  description?: string;
  /** Chart dependencies. */
  dependencies?: Array<{
    name: string;
    version: string;
    repository: string;
  }>;
  /** Helper template names to generate. */
  helpers?: string[];
  /** Per-member defaults. */
  defaults?: {
    chart?: Partial<Record<string, unknown>>;
    helpers?: Partial<Record<string, unknown>>;
  };
}

export interface HelmLibraryResult {
  chart: InstanceType<typeof Chart>;
  helpers: InstanceType<typeof Values>;
}

export const HelmLibrary = Composite<HelmLibraryProps>((props) => {
  const {
    name,
    version = "0.1.0",
    description = `A Helm library chart for ${name}`,
    dependencies = [],
    helpers = ["name", "fullname", "chart", "labels", "selectorLabels"],
    defaults: defs,
  } = props;

  const chartProps: Record<string, unknown> = {
    apiVersion: "v2",
    name,
    version,
    type: "library",
    description,
  };

  if (dependencies.length > 0) {
    chartProps.dependencies = dependencies;
  }

  const chart = new Chart(mergeDefaults(chartProps, defs?.chart));

  // Store helpers list in a Values resource so it's a Declarable member
  const helpersRes = new Values(mergeDefaults({ helpers }, defs?.helpers));

  return { chart, helpers: helpersRes };
}, "HelmLibrary");
