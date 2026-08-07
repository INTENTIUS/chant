/**
 * k3d naming strategy — flat namespace, one short name per entity.
 */

import {
  NamingStrategy as CoreNamingStrategy,
  type NamingConfig,
  type NamingInput,
} from "@intentius/chant/codegen/naming";
import { k3dShortName, k3dServiceName, type K3dParseResult } from "./parse";

export { propertyTypeName, extractDefName } from "@intentius/chant/codegen/naming";

const k3dNamingConfig: NamingConfig = {
  priorityNames: {
    "K3d::Cluster": "Cluster",
    "K3d::Metadata": "Metadata",
    "K3d::KubeAPI": "KubeAPI",
    "K3d::Volume": "Volume",
    "K3d::Port": "Port",
    "K3d::File": "File",
    "K3d::EnvVar": "EnvVar",
    "K3d::HostAlias": "HostAlias",
    "K3d::Registries": "Registries",
    "K3d::RegistryCreate": "RegistryCreate",
    "K3d::RegistryProxy": "RegistryProxy",
    "K3d::Options": "Options",
    "K3d::K3dOptions": "K3dOptions",
    "K3d::LoadbalancerOptions": "LoadbalancerOptions",
    "K3d::K3sOptions": "K3sOptions",
    "K3d::K3sExtraArg": "K3sExtraArg",
    "K3d::NodeLabel": "NodeLabel",
    "K3d::KubeconfigOptions": "KubeconfigOptions",
    "K3d::RuntimeOptions": "RuntimeOptions",
    "K3d::RuntimeLabel": "RuntimeLabel",
    "K3d::Ulimit": "Ulimit",
  },
  priorityAliases: {},
  priorityPropertyAliases: {},
  serviceAbbreviations: {},
  shortName: k3dShortName,
  serviceName: k3dServiceName,
};

/**
 * k3d naming strategy.
 */
export class NamingStrategy extends CoreNamingStrategy {
  constructor(results: K3dParseResult[]) {
    const inputs: NamingInput[] = results.map((r) => ({
      typeName: r.resource.typeName,
      propertyTypes: r.propertyTypes,
    }));
    super(inputs, k3dNamingConfig);
  }
}
