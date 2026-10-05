#!/usr/bin/env bash
# Install the pinned otelcol-contrib, promtool, amtool and tofu, and run the
# unit tests that skip without them (chant #3359, #3463).
#
# The versions come from the lexicons' own pins, so a pin bump moves CI:
#   otelcol-contrib  COLLECTOR_PIN   lexicons/otel/src/define.ts
#   promtool         PROMETHEUS_PIN  lexicons/prometheus/src/pin.ts (prometheus)
#   amtool           PROMETHEUS_PIN  lexicons/prometheus/src/pin.ts (alertmanager)
#   tofu             TOFU_VERSION    below; pr-loop.tofu.test.ts runs the pull-request
#                                   loop over five real roots with it
# Each archive is checked against ci-observability-binaries.sha256 beside this
# script. A pin bump without a digest for the new archive fails here.
#
# Usage:
#   scripts/ci-observability-binaries.sh key
#       Print the pinned versions as one string, for a cache key.
#   scripts/ci-observability-binaries.sh install <dir>
#       Download the archives into <dir> (skipping ones already there), check
#       every digest, extract the binaries into <dir>/bin and print the
#       OTELCOL_BIN, PROMTOOL, AMTOOL and TOFU_BIN exports. Under GitHub Actions it also
#       appends them to $GITHUB_ENV.
#   scripts/ci-observability-binaries.sh test
#       Run every unit test file that names OTELCOL_BIN, PROMTOOL, AMTOOL or
#       hasTool, plus pr-loop.tofu.test.ts, and fail if any test in them was
#       skipped. Needs the four variables set, as `install` sets them.
set -euo pipefail

cd "$(dirname "$0")/.."
# The tofu release the pull-request loop test runs against. A bump needs the
# new archive's digest in the sha256 file (from the release's SHA256SUMS).
tofu_version="1.12.7"
sums="scripts/ci-observability-binaries.sha256"

# The version string after `version:` on the first line matching $2 in file $1, without the "v".
pin() {
  grep -E "$2" "$1" | grep -oE 'version: "v[^"]+"' | head -n 1 | sed -E 's/version: "v([^"]+)"/\1/'
}
# COLLECTOR_PIN spans lines, so take the first version after its declaration.
otel_version="$(sed -n '/export const COLLECTOR_PIN/,/});/p' lexicons/otel/src/define.ts | grep -oE 'version: "v[^"]+"' | head -n 1 | sed -E 's/version: "v([^"]+)"/\1/')"
prom_version="$(pin lexicons/prometheus/src/pin.ts '^ *prometheus: ')"
am_version="$(pin lexicons/prometheus/src/pin.ts '^ *alertmanager: ')"
for v in otel_version prom_version am_version; do
  if [ -z "${!v}" ]; then
    echo "could not read ${v} from the lexicon pins" >&2
    exit 1
  fi
done

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

otel_asset="otelcol-contrib_${otel_version}_${os}_${arch}.tar.gz"
prom_asset="prometheus-${prom_version}.${os}-${arch}.tar.gz"
tofu_asset="tofu_${tofu_version}_${os}_${arch}.zip"
am_asset="alertmanager-${am_version}.${os}-${arch}.tar.gz"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# Download $2 to $1/$3 unless it is there, then check it against the digest file.
fetch() {
  local dir="$1" url="$2" asset="$3" want got
  want="$(awk -v a="$asset" '$2 == a { print $1 }' "$sums")"
  if [ -z "$want" ]; then
    echo "no sha256 for ${asset} in ${sums}; add the release's digest there" >&2
    exit 1
  fi
  if [ ! -f "${dir}/${asset}" ]; then
    echo "downloading ${url}"
    curl -fsSL -o "${dir}/${asset}.part" "$url"
    mv "${dir}/${asset}.part" "${dir}/${asset}"
  fi
  got="$(sha256 "${dir}/${asset}")"
  if [ "$got" != "$want" ]; then
    echo "${asset}: sha256 ${got}, expected ${want}" >&2
    rm -f "${dir}/${asset}"
    exit 1
  fi
}

# Fail unless `$1 --version` names version $2.
check_version() {
  local out
  out="$("$1" --version 2>&1 | head -n 1)"
  echo "$out"
  case "$out" in
    *"$2"*) ;;
    *) echo "$1 is not version $2" >&2; exit 1 ;;
  esac
}

install_binaries() {
  local dir="$1"
  mkdir -p "${dir}/bin"
  dir="$(cd "$dir" && pwd)"

  fetch "$dir" "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${otel_version}/${otel_asset}" "$otel_asset"
  fetch "$dir" "https://github.com/prometheus/prometheus/releases/download/v${prom_version}/${prom_asset}" "$prom_asset"
  fetch "$dir" "https://github.com/prometheus/alertmanager/releases/download/v${am_version}/${am_asset}" "$am_asset"

  fetch "$dir" "https://github.com/opentofu/opentofu/releases/download/v${tofu_version}/${tofu_asset}" "$tofu_asset"

  tar -xzf "${dir}/${otel_asset}" -C "${dir}/bin" otelcol-contrib
  tar -xzf "${dir}/${prom_asset}" -C "${dir}/bin" --strip-components=1 "prometheus-${prom_version}.${os}-${arch}/promtool"
  tar -xzf "${dir}/${am_asset}" -C "${dir}/bin" --strip-components=1 "alertmanager-${am_version}.${os}-${arch}/amtool"

  unzip -o -q "${dir}/${tofu_asset}" tofu -d "${dir}/bin"

  check_version "${dir}/bin/otelcol-contrib" "$otel_version"
  check_version "${dir}/bin/promtool" "$prom_version"
  check_version "${dir}/bin/amtool" "$am_version"
  check_version "${dir}/bin/tofu" "$tofu_version"

  local env="OTELCOL_BIN=${dir}/bin/otelcol-contrib
PROMTOOL=${dir}/bin/promtool
AMTOOL=${dir}/bin/amtool
TOFU_BIN=${dir}/bin/tofu"
  if [ -n "${GITHUB_ENV:-}" ]; then echo "$env" >> "$GITHUB_ENV"; fi
  echo "$env" | sed 's/^/export /'
}

run_tests() {
  for v in OTELCOL_BIN PROMTOOL AMTOOL TOFU_BIN; do
    if [ -z "${!v:-}" ] || [ ! -x "${!v}" ]; then
      echo "${v} does not name an executable; run \`$0 install <dir>\` first" >&2
      exit 1
    fi
  done

  # The test finds tofu on the PATH.
  export PATH="$(dirname "$TOFU_BIN"):$PATH"

  local files
  files="$(grep -rlE 'OTELCOL_BIN|PROMTOOL|AMTOOL|hasTool' --include='*.test.ts' \
    lexicons packages examples test scripts | grep -v node_modules | grep -v '\.e2e\.test\.ts$' | sort)"
  files="$(printf '%s\n%s\n' "$files" lexicons/terraform/src/components/pr-loop.tofu.test.ts | sort -u)"
  echo "test files that need the binaries:"
  echo "$files" | sed 's/^/  /'

  local report
  report="$(mktemp)"
  # shellcheck disable=SC2086
  npx vitest run --project unit --reporter=default --reporter=json --outputFile.json="$report" $files

  # A broken binary path skips a test instead of failing it, so a skip is a failure here.
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
    const skipped = r.testResults.flatMap((f) =>
      f.assertionResults.filter((t) => t.status !== "passed" && t.status !== "failed").map((t) => `${require("path").relative(process.cwd(), f.name)}: ${t.fullName} (${t.status})`));
    if (skipped.length > 0) {
      console.error(`${skipped.length} test(s) skipped with the binaries installed:\n  ${skipped.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`${r.numPassedTests} tests passed in ${r.testResults.length} files, none skipped`);
  ' "$report"
}

case "${1:-}" in
  key) echo "otelcol-contrib-${otel_version}-prometheus-${prom_version}-alertmanager-${am_version}-tofu-${tofu_version}-${os}-${arch}" ;;
  install) install_binaries "${2:?usage: $0 install <dir>}" ;;
  test) run_tests ;;
  *) echo "usage: $0 key | install <dir> | test" >&2; exit 2 ;;
esac
