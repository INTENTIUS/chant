/**
 * _helpers.tpl generation for Helm charts.
 *
 * Generates the standard named templates that Helm charts typically include:
 * chart name, fullname, labels, selectorLabels, chart metadata, serviceAccountName.
 */

export interface HelpersConfig {
  /** Chart name (from Chart.yaml) */
  chartName: string;
  /** Whether to include serviceAccountName helper */
  includeServiceAccount?: boolean;
}

/**
 * Generate the _helpers.tpl content for a Helm chart.
 */
export function generateHelpers(config: HelpersConfig): string {
  const { chartName, includeServiceAccount = true } = config;

  const lines: string[] = [];

  // Chart name
  lines.push(`{{/*
Expand the name of the chart.
*/}}
{{- define "${chartName}.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}`);

  // Fullname
  lines.push(`
{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "${chartName}.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}`);

  // Chart label
  lines.push(`
{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "${chartName}.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}`);

  // Common labels
  lines.push(`
{{/*
Common labels
*/}}
{{- define "${chartName}.labels" -}}
helm.sh/chart: {{ include "${chartName}.chart" . }}
{{ include "${chartName}.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}`);

  // Selector labels
  lines.push(`
{{/*
Selector labels
*/}}
{{- define "${chartName}.selectorLabels" -}}
app.kubernetes.io/name: {{ include "${chartName}.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}`);

  // Service account name
  if (includeServiceAccount) {
    lines.push(`
{{/*
Create the name of the service account to use
*/}}
{{- define "${chartName}.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "${chartName}.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}`);
  }

  return lines.join("\n") + "\n";
}
