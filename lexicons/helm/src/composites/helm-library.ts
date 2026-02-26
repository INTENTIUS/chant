/**
 * HelmLibrary composite — Library chart (type: library, no templates).
 *
 * Produces a Helm library chart with only Chart.yaml and _helpers.tpl.
 */

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
}

export interface HelmLibraryResult {
  chart: Record<string, unknown>;
  helpers: string[];
}

export function HelmLibrary(props: HelmLibraryProps): HelmLibraryResult {
  const {
    name,
    version = "0.1.0",
    description = `A Helm library chart for ${name}`,
    dependencies = [],
    helpers = ["name", "fullname", "chart", "labels", "selectorLabels"],
  } = props;

  const chart: Record<string, unknown> = {
    apiVersion: "v2",
    name,
    version,
    type: "library",
    description,
  };

  if (dependencies.length > 0) {
    chart.dependencies = dependencies;
  }

  return { chart, helpers };
}
