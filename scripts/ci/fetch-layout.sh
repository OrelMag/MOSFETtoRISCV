#!/usr/bin/env bash
# The chip layouts (the release layout-latest, published by layout.yml) unpacked into <dir>, for deploy.yml and desktop.yml.
# Only a release that does not exist is skipped (widgets/chiplayout.ts then shows its placeholder); any other failure (the
# API, the network, a broken archive) fails the job after three tries, so a deploy never ships silently without layouts.
#
#   scripts/ci/fetch-layout.sh <dir>
#
# Needs GH_TOKEN and GITHUB_REPOSITORY. A relative download folder: GNU tar on Windows takes "D:" for a remote host.
set -euo pipefail
dir=$1
repo=${GITHUB_REPOSITORY:?}
mkdir -p "$dir"
if ! out=$(gh release view layout-latest --repo "$repo" --json tagName 2>&1); then
  if grep -qi 'release not found' <<< "$out"; then echo "no layout published yet"; exit 0; fi
  echo "could not look up layout-latest: $out" >&2
  exit 1
fi
for try in 1 2 3; do
  rm -rf layout-dl
  if gh release download layout-latest -p layout.tar.gz -D layout-dl --repo "$repo" && tar -xzf layout-dl/layout.tar.gz -C "$dir"; then
    rm -rf layout-dl
    ls "$dir"
    exit 0
  fi
  echo "layout download failed (try $try of 3)" >&2
  [ "$try" -lt 3 ] && sleep $((try * 20))
done
echo "layout-latest exists but could not be downloaded and unpacked: not deploying without it" >&2
exit 1
