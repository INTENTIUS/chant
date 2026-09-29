#!/usr/bin/env bash
# Usage: capture.sh <tag> <outdir>
set -u
TAG=$1; OUT=$2; mkdir -p "$OUT"
NAME="chant-2949-capture-${TAG//./-}-$$"
docker run -d --rm --name "$NAME" -p 127.0.0.1::3000 -e GF_AUTH_ANONYMOUS_ENABLED=true -e GF_AUTH_ANONYMOUS_ORG_ROLE=Admin grafana/grafana:$TAG >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT
PORT=$(docker port "$NAME" 3000 | head -1 | sed 's/.*://')
G="http://127.0.0.1:$PORT"
for i in $(seq 1 90); do curl -sf "$G/api/health" >/dev/null && break; sleep 1; done
H=(-H 'Content-Type: application/json' -u admin:admin)
p(){ curl -s "${H[@]}" -X "$1" "$G$2" ${3:+-d "$3"}; echo; }
docker exec "$NAME" grafana-server -v 2>/dev/null | head -1 > "$OUT/version.txt" || true
curl -s "$G/api/health" >> "$OUT/version.txt"
p POST /api/datasources '{"name":"Prometheus","type":"prometheus","uid":"prom","url":"http://prometheus:9090","access":"proxy"}' 
p POST /api/datasources '{"name":"Loki","type":"loki","uid":"loki","url":"http://loki:3100","access":"proxy"}'
p POST /api/folders '{"uid":"chant-fx-alerts","title":"Checkout alerts"}'
# Templates
p PUT /api/v1/provisioning/templates/checkout.message '{"template":"{{ define \"checkout.message\" }}{{ len .Alerts.Firing }} firing{{ end }}"}'
# Mute timing
p POST /api/v1/provisioning/mute-timings '{"name":"weekends","time_intervals":[{"weekdays":["saturday","sunday"],"location":"Europe/Berlin"}]}'
p POST /api/v1/provisioning/mute-timings '{"name":"release-window","time_intervals":[{"times":[{"start_time":"22:00","end_time":"23:30"}],"weekdays":["tuesday:thursday"],"days_of_month":["1:7"],"months":["january:march"]}]}'
# Contact points
p POST /api/v1/provisioning/contact-points '{"uid":"chant-fx-oncall-email","name":"oncall","type":"email","settings":{"addresses":"oncall@example.com;sre@example.com","singleEmail":true,"message":"{{ template \"checkout.message\" . }}"},"disableResolveMessage":false}'
p POST /api/v1/provisioning/contact-points '{"uid":"chant-fx-oncall-slack","name":"oncall","type":"slack","settings":{"url":"https://hooks.slack.com/services/T000/B000/XXXX","recipient":"#checkout-alerts","title":"{{ .CommonLabels.alertname }}"}}'
p POST /api/v1/provisioning/contact-points '{"uid":"chant-fx-tickets","name":"tickets","type":"webhook","settings":{"url":"https://tickets.example.com/hook","httpMethod":"POST","maxAlerts":"10"}}'
# Policy tree
p PUT /api/v1/provisioning/policies '{"receiver":"oncall","group_by":["grafana_folder","alertname"],"group_wait":"30s","group_interval":"5m","repeat_interval":"4h","routes":[{"receiver":"tickets","object_matchers":[["severity","=","ticket"]],"mute_time_intervals":["weekends"],"continue":false},{"receiver":"oncall","object_matchers":[["severity","=","page"],["team","=~","checkout|payments"]],"group_wait":"10s","routes":[{"receiver":"tickets","object_matchers":[["env","!=","prod"]],"active_time_intervals":["release-window"]}]}]}'
# Rule groups via ruler-free provisioning API (PUT group)
RULES=$(cat <<'J'
{"title":"checkout","interval":60,"rules":[
 {"uid":"chant-fx-checkout-errors","title":"Checkout error ratio","condition":"C","folderUID":"chant-fx-alerts","ruleGroup":"checkout","orgID":1,
  "data":[
   {"refId":"A","relativeTimeRange":{"from":600,"to":0},"datasourceUid":"prom","model":{"datasource":{"type":"prometheus","uid":"prom"},"editorMode":"code","expr":"sum(rate(http_requests_total{job=\"checkout\",code=~\"5..\"}[5m])) / sum(rate(http_requests_total{job=\"checkout\"}[5m]))","instant":true,"intervalMs":1000,"legendFormat":"__auto","maxDataPoints":43200,"range":false,"refId":"A"}},
   {"refId":"B","relativeTimeRange":{"from":0,"to":0},"datasourceUid":"__expr__","model":{"conditions":[{"evaluator":{"params":[],"type":"gt"},"operator":{"type":"and"},"query":{"params":["B"]},"reducer":{"params":[],"type":"last"},"type":"query"}],"datasource":{"type":"__expr__","uid":"__expr__"},"expression":"A","intervalMs":1000,"maxDataPoints":43200,"reducer":"last","refId":"B","settings":{"mode":"dropNN"},"type":"reduce"}},
   {"refId":"C","relativeTimeRange":{"from":0,"to":0},"datasourceUid":"__expr__","model":{"conditions":[{"evaluator":{"params":[0.05],"type":"gt"},"unloadEvaluator":{"params":[0.03],"type":"lt"},"operator":{"type":"and"},"query":{"params":["C"]},"reducer":{"params":[],"type":"last"},"type":"query"}],"datasource":{"type":"__expr__","uid":"__expr__"},"expression":"B","intervalMs":1000,"maxDataPoints":43200,"refId":"C","type":"threshold"}}],
  "noDataState":"NoData","execErrState":"Error","for":"5m","keep_firing_for":"2m","annotations":{"summary":"Checkout 5xx ratio is {{ humanizePercentage $values.B.Value }}","runbook_url":"https://runbooks.example.com/checkout"},"labels":{"severity":"page","team":"checkout"},"isPaused":false},
 {"uid":"chant-fx-checkout-latency","title":"Checkout p99 latency","condition":"D","folderUID":"chant-fx-alerts","ruleGroup":"checkout","orgID":1,
  "data":[
   {"refId":"A","relativeTimeRange":{"from":1800,"to":0},"datasourceUid":"prom","model":{"datasource":{"type":"prometheus","uid":"prom"},"expr":"histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{job=\"checkout\"}[5m])))","intervalMs":1000,"maxDataPoints":43200,"refId":"A","range":true,"instant":false}},
   {"refId":"B","datasourceUid":"__expr__","model":{"datasource":{"type":"__expr__","uid":"__expr__"},"expression":"A","downsampler":"mean","upsampler":"fillna","window":"1m","refId":"B","type":"resample"}},
   {"refId":"C","datasourceUid":"__expr__","model":{"datasource":{"type":"__expr__","uid":"__expr__"},"expression":"B","reducer":"max","settings":{"mode":"replaceNN","replaceWithValue":0},"refId":"C","type":"reduce"}},
   {"refId":"D","datasourceUid":"__expr__","model":{"datasource":{"type":"__expr__","uid":"__expr__"},"expression":"$C > 0.5 && $C < 100","refId":"D","type":"math"}}],
  "noDataState":"OK","execErrState":"KeepLast","for":"10m","labels":{"severity":"ticket"},"annotations":{"summary":"p99 above 500ms"},"isPaused":true,
  "notification_settings":{"receiver":"tickets","group_by":["alertname","grafana_folder"],"group_wait":"1m","repeat_interval":"12h","mute_time_intervals":["weekends"]}},
 {"uid":"chant-fx-checkout-logs","title":"Checkout panics","condition":"B","folderUID":"chant-fx-alerts","ruleGroup":"checkout","orgID":1,
  "data":[
   {"refId":"A","queryType":"range","relativeTimeRange":{"from":300,"to":0},"datasourceUid":"loki","model":{"datasource":{"type":"loki","uid":"loki"},"editorMode":"code","expr":"sum(count_over_time({app=\"checkout\"} |= \"panic\" [5m]))","queryType":"range","refId":"A"}},
   {"refId":"B","datasourceUid":"__expr__","model":{"datasource":{"type":"__expr__","uid":"__expr__"},"conditions":[{"evaluator":{"params":[0],"type":"gt"},"operator":{"type":"and"},"query":{"params":["A"]},"reducer":{"params":[],"type":"sum"},"type":"query"}],"refId":"B","type":"classic_conditions"}}],
  "noDataState":"OK","execErrState":"Error","for":"0s","labels":{"severity":"page"},"annotations":{"description":"A panic was logged"},"isPaused":false,"missing_series_evals_to_resolve":3},
 {"uid":"chant-fx-checkout-rps","title":"checkout rps","folderUID":"chant-fx-alerts","ruleGroup":"checkout","orgID":1,
  "data":[
   {"refId":"A","relativeTimeRange":{"from":600,"to":0},"datasourceUid":"prom","model":{"datasource":{"type":"prometheus","uid":"prom"},"expr":"sum(rate(http_requests_total{job=\"checkout\"}[5m]))","instant":true,"refId":"A"}}],
  "record":{"metric":"checkout:requests:rate5m","from":"A","targetDatasourceUid":"prom"},"labels":{"team":"checkout"},"noDataState":"OK","execErrState":"Error","for":"0s","isPaused":false}
]}
J
)
p PUT /api/v1/provisioning/folder/chant-fx-alerts/rule-groups/checkout "$RULES"
for kind in alert-rules contact-points policies mute-timings templates; do
  for fmt in yaml json; do curl -s -u admin:admin "$G/api/v1/provisioning/$kind/export?format=$fmt&decrypt=false" > "$OUT/$kind.export.$fmt"; done
done
curl -s -u admin:admin "$G/api/v1/provisioning/contact-points/export?format=yaml&decrypt=true" > "$OUT/contact-points.export.decrypted.yaml"
curl -s -u admin:admin "$G/api/alert-notifiers?version=2" > "$OUT/alert-notifiers.json" 2>/dev/null
[ -s "$OUT/alert-notifiers.json" ] || curl -s -u admin:admin "$G/api/alert-notifiers" > "$OUT/alert-notifiers.json"
curl -s -u admin:admin "$G/api/v1/provisioning/alert-rules" > "$OUT/alert-rules.list.json"
echo done $TAG
