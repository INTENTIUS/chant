/**
 * The ruler and Alertmanager API clients (#3371), as
 * `@intentius/chant-lexicon-prometheus/api`.
 *
 * One transport for observe, live export and the ruler apply target
 * (#3372): bind with {@link bindEndpoints} (or {@link bindRuler} /
 * {@link bindAlertmanager}), then read and write through {@link RulerApi}
 * and {@link AlertmanagerApi}. The ownership boundary is
 * {@link declaredNamespaces}: nothing outside it is read for import, and an
 * apply must not write or delete outside it.
 */

export { PromApiError, PromClient, promHttp, statusVerdict, type PromAuth, type PromHttp, type PromResponse, type PromTarget, type StatusVerdict } from "./client";
export { RulerApi, type EvaluatedGroup, type EvaluatedRule, type RawRuleGroup } from "./ruler";
export { AlertmanagerApi, type AlertmanagerHealth, type LiveAlertmanagerConfig } from "./alertmanager";
export { evaluatedToRuleGroup, groupHealth, type GroupHealth } from "./evaluated";
export { bindAlertmanager, bindEndpoints, bindRuler, classifyPromFailure, PromBindingError, type BindOptions, type BoundEndpoints } from "./bind";
export {
  ALERTMANAGER_KINDS,
  RULER_KINDS,
  declaredNamespaces,
  namespaceOfGroup,
  resolveAlertmanagerTarget,
  resolveRulerTarget,
  type AlertmanagerKind,
  type AlertmanagerTarget,
  type RulerKind,
  type RulerTarget,
} from "../config";
