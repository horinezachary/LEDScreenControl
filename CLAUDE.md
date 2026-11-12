# LED Monitor

Monitoring dashboard for Brompton and NovaStar LED processors. See README.md for layout and commands, and the design
doc linked there for the plan (phases 1 to 5).

## Working agreement

Features go on a branch and a pull request. Zac reviews, then merges. Title PRs `feat: ...` for features and `fix: ...`
for fixes; the title decides the version bump.

## Versions and releases

Same scheme as horine-server-console and Lodgemaster Email Tools. Every merge to main is released by
`.github/workflows/auto-release.yml`: it tags the merge commit `vX.Y.Z` (annotated) and publishes a GitHub release with
notes generated from the PRs since the last tag. The bump comes from the PR title and commit messages
(`.github/scripts/next-version.sh`): `feat:` minor, `!:` or `BREAKING CHANGE` major, anything else patch; `[skip release]`
in the PR title skips it. Nothing is committed back and no file holds the version (package.json stays `0.1.0`): the tag
is the version. Builds read it with `scripts/app-version.sh` (the tag on the commit, or the number auto-release will give,
with `-dev` off main). The first release counts from 0.0.0.

## Real processors

The processors are live show equipment. Reading from them is fine. **Ask Zac before sending any control command**
(brightness, preset, input, blackout, freeze, failover, reboot, any Tessera `?set=` or COEX PUT/POST). Develop against
the simulator (`packages/server/src/sim`).

## Testing

`npm test` runs every package's tests (vitest). `npm run typecheck` checks types. CI also starts the built server in
demo mode and checks it answers. The Mac app is packaged by the "Mac app" workflow on macOS.
