#!/usr/bin/env bash
#
# Stop one dedicated instance started by run-dedicated.sh, from its own directory -- which is the
# only place `aspire stop` can find it, exactly as AppHost A and AppHost B are each stopped from
# theirs. The generated directory is left behind; it is rewritten on the next run and `git clean`
# takes it away.
set -euo pipefail

slug=${1:-}
if [[ -z "$slug" ]]; then
  echo "usage: $0 <tenant-slug>" >&2
  exit 2
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
run_dir="$here/../AppHostB-$slug"
if [[ ! -d "$run_dir" ]]; then
  echo "no generated run directory for '$slug' ($run_dir); nothing to stop." >&2
  exit 0
fi
cd "$run_dir"
exec aspire stop --non-interactive --nologo
