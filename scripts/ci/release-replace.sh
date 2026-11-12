#!/usr/bin/env bash
# Publishes files as the assets of a GitHub release that already exists without a moment where it has none (desktop.yml,
# layout.yml): the new assets go in beside the old, the tag moves to the commit built, title and notes follow, then the
# assets this run did not upload go. A run cancelled half way leaves old and new side by side, never an empty release.
# The first time (no such release) it is created.
#
#   scripts/ci/release-replace.sh <tag> <sha> <prerelease true|false> <title> <notes> <file>...
#
# Needs GH_TOKEN with contents: write and GITHUB_REPOSITORY.
set -euo pipefail
tag=$1 sha=$2 pre=$3 title=$4 notes=$5
shift 5
repo=${GITHUB_REPOSITORY:?}
[ $# -gt 0 ] || { echo "release-replace: no files" >&2; exit 1; }
for f in "$@"; do [ -s "$f" ] || { echo "release-replace: $f is missing or empty" >&2; exit 1; }; done

if ! gh release view "$tag" --repo "$repo" > /dev/null 2>&1; then
  gh release create "$tag" "$@" --repo "$repo" --target "$sha" --title "$title" --notes "$notes" --prerelease="$pre"
  exit 0
fi

# 1. the new assets beside the old (a name already there, as on a re-run of the same commit, is replaced in place)
gh release upload "$tag" "$@" --repo "$repo" --clobber
# 2. the tag to the commit these were built from (a lightweight tag: gh release create made it)
gh api -X PATCH "repos/$repo/git/refs/tags/$tag" -f sha="$sha" -F force=true > /dev/null
# 3. title and notes
gh release edit "$tag" --repo "$repo" --title "$title" --notes "$notes" --prerelease="$pre"
# 4. what this run did not upload
keep=$(for f in "$@"; do basename "$f"; done)
gh release view "$tag" --repo "$repo" --json assets -q '.assets[].name' | while IFS= read -r a; do
  a=${a%$'\r'} # gh on the Windows runner
  if ! grep -qxF -- "$a" <<< "$keep"; then gh release delete-asset "$tag" "$a" --repo "$repo" --yes; fi
done
echo "release $tag: $(gh release view "$tag" --repo "$repo" --json assets -q '[.assets[].name] | join(", ")') at $sha"
