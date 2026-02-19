/**
 * Core lint rules for chant projects (COR + EVL).
 */

import type { LintRule } from "../rule";

export { flatDeclarationsRule } from "./flat-declarations";
export { exportRequiredRule } from "./export-required";
export { fileDeclarableLimitRule } from "./file-declarable-limit";
export { singleConcernFileRule } from "./single-concern-file";
export { preferNamespaceImportRule } from "./prefer-namespace-import";
export { barrelImportStyleRule } from "./barrel-import-style";
export { declarableNamingConventionRule } from "./declarable-naming-convention";
export { noUnusedDeclarableImportRule } from "./no-unused-declarable-import";
export { noRedundantValueCastRule } from "./no-redundant-value-cast";
export { noUnusedDeclarableRule } from "./no-unused-declarable";
export { noCyclicDeclarableRefRule } from "./no-cyclic-declarable-ref";
export { noRedundantTypeImportRule } from "./no-redundant-type-import";
export { noStringRefRule } from "./no-string-ref";
export { enforceBarrelImportRule } from "./enforce-barrel-import";
export { enforceBarrelRefRule } from "./enforce-barrel-ref";
export { evl001NonLiteralExpressionRule } from "./evl001-non-literal-expression";
export { evl002ControlFlowResourceRule } from "./evl002-control-flow-resource";
export { evl003DynamicPropertyAccessRule } from "./evl003-dynamic-property-access";
export { evl004SpreadNonConstRule } from "./evl004-spread-non-const";
export { evl005ResourceBlockBodyRule } from "./evl005-resource-block-body";
export { evl006BarrelUsageRule } from "./evl006-barrel-usage";
export { evl007InvalidSiblingsRule } from "./evl007-invalid-siblings";
export { evl008UnresolvableBarrelRefRule } from "./evl008-unresolvable-barrel-ref";
export { staleBarrelTypesRule } from "./stale-barrel-types";
export { evl009CompositeNoConstantRule } from "./evl009-composite-no-constant";
export { evl010CompositeNoTransformRule } from "./evl010-composite-no-transform";
export { cor017CompositeNameMatchRule } from "./cor017-composite-name-match";
export { cor018CompositePreferLexiconTypeRule } from "./cor018-composite-prefer-lexicon-type";

import { flatDeclarationsRule } from "./flat-declarations";
import { exportRequiredRule } from "./export-required";
import { fileDeclarableLimitRule } from "./file-declarable-limit";
import { singleConcernFileRule } from "./single-concern-file";
import { preferNamespaceImportRule } from "./prefer-namespace-import";
import { barrelImportStyleRule } from "./barrel-import-style";
import { declarableNamingConventionRule } from "./declarable-naming-convention";
import { noUnusedDeclarableImportRule } from "./no-unused-declarable-import";
import { noRedundantValueCastRule } from "./no-redundant-value-cast";
import { noUnusedDeclarableRule } from "./no-unused-declarable";
import { noCyclicDeclarableRefRule } from "./no-cyclic-declarable-ref";
import { noRedundantTypeImportRule } from "./no-redundant-type-import";
import { noStringRefRule } from "./no-string-ref";
import { enforceBarrelImportRule } from "./enforce-barrel-import";
import { enforceBarrelRefRule } from "./enforce-barrel-ref";
import { evl001NonLiteralExpressionRule } from "./evl001-non-literal-expression";
import { evl002ControlFlowResourceRule } from "./evl002-control-flow-resource";
import { evl003DynamicPropertyAccessRule } from "./evl003-dynamic-property-access";
import { evl004SpreadNonConstRule } from "./evl004-spread-non-const";
import { evl005ResourceBlockBodyRule } from "./evl005-resource-block-body";
import { evl006BarrelUsageRule } from "./evl006-barrel-usage";
import { evl007InvalidSiblingsRule } from "./evl007-invalid-siblings";
import { evl008UnresolvableBarrelRefRule } from "./evl008-unresolvable-barrel-ref";
import { staleBarrelTypesRule } from "./stale-barrel-types";
import { evl009CompositeNoConstantRule } from "./evl009-composite-no-constant";
import { evl010CompositeNoTransformRule } from "./evl010-composite-no-transform";
import { cor017CompositeNameMatchRule } from "./cor017-composite-name-match";
import { cor018CompositePreferLexiconTypeRule } from "./cor018-composite-prefer-lexicon-type";

/**
 * Load all 28 core lint rules (COR + EVL).
 */
export function loadCoreRules(): LintRule[] {
  return [
    flatDeclarationsRule,
    exportRequiredRule,
    fileDeclarableLimitRule,
    singleConcernFileRule,
    preferNamespaceImportRule,
    barrelImportStyleRule,
    declarableNamingConventionRule,
    noUnusedDeclarableImportRule,
    noRedundantValueCastRule,
    noUnusedDeclarableRule,
    noCyclicDeclarableRefRule,
    noRedundantTypeImportRule,
    noStringRefRule,
    enforceBarrelImportRule,
    enforceBarrelRefRule,
    evl001NonLiteralExpressionRule,
    evl002ControlFlowResourceRule,
    evl003DynamicPropertyAccessRule,
    evl004SpreadNonConstRule,
    evl005ResourceBlockBodyRule,
    evl006BarrelUsageRule,
    evl007InvalidSiblingsRule,
    evl008UnresolvableBarrelRefRule,
    staleBarrelTypesRule,
    evl009CompositeNoConstantRule,
    evl010CompositeNoTransformRule,
    cor017CompositeNameMatchRule,
    cor018CompositePreferLexiconTypeRule,
  ];
}
