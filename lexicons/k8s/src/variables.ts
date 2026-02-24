/**
 * Kubernetes pseudo-parameters / well-known variables.
 *
 * Unlike AWS which has built-in pseudo-parameters (AWS::Region, etc.),
 * Kubernetes doesn't have equivalent built-in variables. This module
 * provides common label key constants for use in resource definitions.
 */

/**
 * Well-known Kubernetes label keys from the standard label taxonomy.
 * These are string constants, not runtime-resolved pseudo-parameters.
 */
export const K8sLabels = {
  /** app.kubernetes.io/name */
  AppName: "app.kubernetes.io/name",
  /** app.kubernetes.io/instance */
  AppInstance: "app.kubernetes.io/instance",
  /** app.kubernetes.io/version */
  AppVersion: "app.kubernetes.io/version",
  /** app.kubernetes.io/component */
  AppComponent: "app.kubernetes.io/component",
  /** app.kubernetes.io/part-of */
  AppPartOf: "app.kubernetes.io/part-of",
  /** app.kubernetes.io/managed-by */
  AppManagedBy: "app.kubernetes.io/managed-by",
} as const;

/**
 * Well-known Kubernetes annotation keys.
 */
export const K8sAnnotations = {
  /** kubernetes.io/change-cause */
  ChangeCause: "kubernetes.io/change-cause",
  /** kubernetes.io/description */
  Description: "kubernetes.io/description",
} as const;
