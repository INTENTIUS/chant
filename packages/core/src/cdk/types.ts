/**
 * The parts of a CDK cloud assembly the carve advisor reads (#1056).
 *
 * A cloud assembly is already JSON, so there is no parser to install and no
 * expression AST to resolve — the Terraform path's two hardest layers do not
 * exist here. Three files carry everything the advisor needs:
 *
 *  - `manifest.json` — which artifacts are stacks, which template file each
 *    one synthesized to, and (crucially) whether any context lookup went
 *    unresolved.
 *  - `tree.json` — the construct tree, so CloudFormation resources can be
 *    grouped back under the construct that emitted them. Optional: CDK can be
 *    told not to write it, and the advisor degrades to a coarser grouping.
 *  - `*.template.json` — the CloudFormation templates themselves, already in
 *    `AWS::*` type space, which is exactly what the AWS tier map keys on.
 *
 * Everything here is post-jsii, so a Python or Java CDK app reads through the
 * same code path as a TypeScript one. Nothing in this module reads CDK source.
 *
 * The declarations are deliberately loose — every field optional, unknown keys
 * tolerated — because the assembly schema is not chant's to own and gains
 * fields between CDK releases.
 */

/** A CloudFormation resource as it appears in a synthesized template. */
export interface CfnResource {
  Type?: string;
  Properties?: Record<string, unknown>;
  /** `aws:cdk:path` names the emitting construct; `aws:asset:*` marks an asset. */
  Metadata?: Record<string, unknown>;
  DependsOn?: string | string[];
  /** Names a template `Condition` — the CloudFormation analogue of `count`. */
  Condition?: string;
  [k: string]: unknown;
}

/** A CloudFormation `Outputs` entry. */
export interface CfnOutput {
  Value?: unknown;
  Export?: { Name?: unknown };
  [k: string]: unknown;
}

export interface CfnTemplate {
  Parameters?: Record<string, Record<string, unknown>>;
  Conditions?: Record<string, unknown>;
  Resources?: Record<string, CfnResource>;
  Outputs?: Record<string, CfnOutput>;
  [k: string]: unknown;
}

/** One artifact in `manifest.json`. */
export interface CdkArtifact {
  type?: string;
  properties?: { templateFile?: string; [k: string]: unknown };
  displayName?: string;
  dependencies?: string[];
  environment?: string;
  [k: string]: unknown;
}

/** One unresolved context lookup, as `cdk synth` records it. */
export interface CdkMissingContext {
  key?: string;
  provider?: string;
  props?: Record<string, unknown>;
}

export interface CdkManifest {
  version?: string;
  artifacts?: Record<string, CdkArtifact>;
  /**
   * Context queries synthesis could not answer. Non-empty means the templates
   * hold placeholder values rather than the real account's, so nothing
   * synthesized from them describes real infrastructure.
   */
  missing?: CdkMissingContext[];
  [k: string]: unknown;
}

/** A node of `tree.json`. Children are keyed by construct id. */
export interface CdkTreeNode {
  id?: string;
  path?: string;
  children?: Record<string, CdkTreeNode>;
  /** `fqn` is the construct class — the L1/L2/L3 signal. */
  constructInfo?: { fqn?: string; version?: string };
  attributes?: Record<string, unknown>;
}

export interface CdkTreeFile {
  version?: string;
  tree?: CdkTreeNode;
}

/** One CloudFormation stack artifact, with its template read. */
export interface CdkStack {
  /** Artifact id in `manifest.json`, e.g. `Stage-AppStack`. */
  id: string;
  /** Construct path of the stack, e.g. `Stage/AppStack`. */
  path: string;
  templateFile: string;
  template: CfnTemplate;
}

/** A read cloud assembly: the manifest, the construct tree, the stacks. */
export interface CloudAssembly {
  dir: string;
  manifest: CdkManifest;
  /** Absent when the app was synthesized without tree metadata. */
  tree?: CdkTreeNode;
  stacks: CdkStack[];
  /** Everything that went wrong or is worth saying about the read itself. */
  diagnostics: string[];
}
