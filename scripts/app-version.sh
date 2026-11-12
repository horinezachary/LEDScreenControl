#!/usr/bin/env bash
# Prints the version of this checkout, for the dashboard footer and the launcher app (scripts/build.sh).
#
# A merge to main is tagged by .github/workflows/auto-release.yml a few seconds after it lands, so a deploy that starts
# straight away builds before its tag exists. Rather than show "1.8.5 + 4 commits", this works out the version the
# release workflow gives (or will give) each merge since the last tag, with the same rules (.github/scripts/next-version.sh,
# "[skip release]" skipped), so the footer always shows a release number.
#
# Outside main (a feature branch checked out locally) the number is the one a merge of the branch would get, followed by
# "-dev".
set -euo pipefail
cd "$(dirname "$0")/.."

exact=$(git describe --tags --exact-match --match 'v*' HEAD 2>/dev/null || true)
if [ -n "$exact" ]; then
  echo "$exact"
  exit 0
fi

last=$(git describe --tags --abbrev=0 --match 'v*' HEAD 2>/dev/null || true)
if [ -z "$last" ]; then
  # No release yet (or a shallow clone without tags): count from the first commit, as auto-release.yml does.
  last=$(git rev-list --max-parents=0 HEAD | tail -n1)
  version=0.0.0
else
  version=${last#v}
fi
from=$last

# On a branch that is not on main yet, only the merges already on main are releases of their own. The branch's own
# commits will reach main as one merge, so they count as one release together, however many "feat:" commits or merges
# of other branches it holds: the number shown is the one that merge will get.
on_main=yes
main_end=HEAD
if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ] &&
   ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  on_main=no
  base=$(git merge-base HEAD origin/main 2>/dev/null || true)
  if [ -n "$base" ] && git merge-base --is-ancestor "$last" "$base"; then
    main_end=$base
  else
    main_end=$last
  fi
fi

for commit in $(git rev-list --first-parent --reverse "$last..$main_end"); do
  # Like the workflow: a skipped merge gets no number, and its changes count towards the next release.
  if git log -1 --format=%B "$commit" | grep -qF '[skip release]'; then
    continue
  fi
  version=$(.github/scripts/next-version.sh "$version" "$from..$commit")
  from=$commit
done

if [ "$on_main" = no ]; then
  version=$(.github/scripts/next-version.sh "$version" "$from..HEAD")
  echo "v$version-dev"
else
  echo "v$version"
fi
