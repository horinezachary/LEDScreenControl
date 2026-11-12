#!/usr/bin/env bash
# Prints the next version, worked out from the commit messages since the last release.
#
#   next-version.sh <current-version> <git-range>
#
# Any message (subject or body, so a merged PR's title counts too) with a line that starts
#   "feat!:", "fix(scope)!:" ... or contains "BREAKING CHANGE"  -> major (2.0.0)
#   "feat:" or "feat(scope):"                                    -> minor (1.1.0)
# Anything else                                                  -> patch (1.0.1)
set -euo pipefail

current="$1"
range="$2"

IFS=. read -r major minor patch <<<"$current"
messages="$(git log --format=%B "$range")"

if grep -Eq '^[a-z]+(\([^)]*\))?!:|BREAKING CHANGE' <<<"$messages"; then
  echo "$((major + 1)).0.0"
elif grep -Eq '^feat(\([^)]*\))?:' <<<"$messages"; then
  echo "$major.$((minor + 1)).0"
else
  echo "$major.$minor.$((patch + 1))"
fi
