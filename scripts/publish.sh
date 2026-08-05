#!/usr/bin/env sh
#
# Publish the workspace to npm, in dependency order.
#
#   sh scripts/publish.sh --check     # clean, test and inspect packs; publish nothing
#   sh scripts/publish.sh 123456      # 123456 is the code from your authenticator
#
# npm will not accept a plain token for this. As of July 2026 a token publish is
# refused unless the token bypasses 2FA, and that bypass is being retired
# (account operations August 2026, direct publishing around January 2027). The
# successor is trusted publishing over OIDC, which cannot do a package's *first*
# publish, because npm requires the package to exist before a trusted publisher
# can be configured for it. So this run is a person with an authenticator, and
# the ones after it do not have to be.
#
# Re-runnable: a package already on the registry at its current version is
# skipped only when its registry integrity matches the locally packed artifact,
# so a run interrupted halfway can safely be repeated. One code covers the
# whole run if the run outlives its 30-second
# window — if npm starts rejecting it partway through, take a fresh code and go
# again.

set -eu

CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY=1
  shift
fi

# Optional: an account whose 2FA is a security key has no six-digit code to give,
# and an account that does not require 2FA for writes does not need one either.
OTP="${1:-${NPM_OTP:-}}"

# Every live registry operation names its target explicitly. A user or project
# .npmrc (or npm_config_* environment) can silently redirect identity, lookup
# and publish traffic to another registry. Scoped packages consult their scope
# registry before the global one, so every live command pins both keys at CLI
# precedence and can only ever talk to the reviewed public registry.
NPM_REGISTRY='https://registry.npmjs.org/'

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "release refused: the worktree must be clean before release checks or publication" >&2
  exit 1
fi

# The live-publish gate: only a clean worktree whose attached HEAD is the
# default branch and exactly matches the freshly fetched remote default-branch
# commit may publish. This rejects release branches, detached HEADs and a local
# default branch that became stale after checkout. It runs twice — once before
# the long preflight, and again immediately before authentication — because
# both the worktree and the remote default branch can change while the checks
# run, and the second run is the one that guards the irreversible step.
assert_live_release_head() {
  gate_stage="$1"

  if [ -n "$(git status --porcelain)" ]; then
    echo "release refused: the worktree must be clean $gate_stage" >&2
    exit 1
  fi

  current_branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
  if [ -z "$current_branch" ]; then
    echo "release refused: publication requires the checked-out default branch, not a detached HEAD" >&2
    exit 1
  fi

  default_ref=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  case "$default_ref" in
    origin/*) default_branch=${default_ref#origin/} ;;
    *)
      echo "release refused: origin's default branch is not configured" >&2
      exit 1
      ;;
  esac

  if [ "$current_branch" != "$default_branch" ]; then
    echo "release refused: publication requires the default branch '$default_branch' (currently '$current_branch')" >&2
    exit 1
  fi

  if ! git fetch --quiet --no-tags origin "+refs/heads/$default_branch:refs/remotes/origin/$default_branch"; then
    echo "release refused: could not refresh origin/$default_branch" >&2
    exit 1
  fi

  head_commit=$(git rev-parse HEAD)
  remote_commit=$(git rev-parse "refs/remotes/origin/$default_branch")
  if [ "$head_commit" != "$remote_commit" ]; then
    echo "release refused: HEAD must exactly match the freshly fetched origin/$default_branch release commit $gate_stage" >&2
    exit 1
  fi
}

# A pull request may exercise the entire preflight with --check, but the live
# path is deliberately narrower and never reached by --check.
if [ "$CHECK_ONLY" -eq 0 ]; then
  assert_live_release_head 'before release checks'
fi

echo "==> Checking release manifests"
npm run release:check

if ! git ls-files --error-unmatch bun.lock >/dev/null 2>&1 || [ ! -f bun.lock ]; then
  echo "release refused: bun.lock must exist and be committed before --frozen-lockfile can protect this build" >&2
  exit 1
fi

echo "==> Installing the committed dependency graph"
bun install --frozen-lockfile

echo "==> Cleaning generated artifacts"
npm run clean

echo "==> Building"
npm run build

echo "==> Typechecking source and tests"
npm run typecheck

echo "==> Testing"
npm test

echo "==> Checking publishable tarballs"
PACK_TMP=$(mktemp -d "${TMPDIR:-/tmp}/kei-release-packs.XXXXXX")
trap 'rm -rf "$PACK_TMP"' EXIT HUP INT TERM

# This loop used to live here, which meant CI could not run it and the only
# check that reads the real tarball ran at the moment a mistake had already cost
# a version number. It now lives in check-packs.mjs, which CI runs on every push
# (#158); the release keeps the artifacts by naming a destination, so the
# integrity comparison below still compares the very tarballs that were checked.
node scripts/check-packs.mjs --pack-destination="$PACK_TMP"

# The publish set and its dependency order come from the same derivation the
# pack check just used, rather than from a second hand-maintained list here that
# could quietly omit a package added to packages/ later.
PACKAGES=$(cat "$PACK_TMP/order.txt")

# check-packs.mjs asserts this too. It is repeated here because it is the one
# manifest field that can redirect an irreversible publish — publishConfig.registry
# outranks even a per-command --registry flag — and this script is the one that
# runs npm publish. Deliberate belt and braces, checked before authentication.
for package in $PACKAGES; do
  directory="packages/$package"
  manifest_registry=$(node -p "require('./$directory/package.json').publishConfig?.registry ?? ''")
  if [ -n "$manifest_registry" ] && [ "$manifest_registry" != "$NPM_REGISTRY" ]; then
    echo "release refused: $directory publishConfig.registry '$manifest_registry' is not the pinned public registry $NPM_REGISTRY" >&2
    exit 1
  fi
done

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "Preflight passed. Nothing was published."
  exit 0
fi

# Re-run the gate now that the long preflight is over: master advancing during
# the checks, or anything the checks left in the worktree, must refuse here,
# before the first authenticated or irreversible registry operation.
echo "==> Re-verifying the release head after preflight"
assert_live_release_head 'immediately before publication'

echo "==> Verifying npm publisher identity"
if ! npm whoami --registry="$NPM_REGISTRY" --@keicoin:registry="$NPM_REGISTRY" >/dev/null; then
  echo "release refused: npm authentication is required before publication" >&2
  exit 1
fi

for package in $PACKAGES; do
  directory="packages/$package"
  name=$(node -p "require('./$directory/package.json').name")
  version=$(node -p "require('./$directory/package.json').version")
  report="$PACK_TMP/$package.json"
  filename=$(node scripts/check-pack.mjs "$name" "$version" "$directory/package.json" --field=filename < "$report")
  local_integrity=$(node scripts/check-pack.mjs "$name" "$version" "$directory/package.json" --field=integrity < "$report")
  view_output="$PACK_TMP/$package.view.json"
  view_error="$PACK_TMP/$package.view.err"

  # --prefer-online, because a 404 from before the first publish is cached, and a
  # stale "not published" is the one wrong answer that makes this loop fail.
  if npm view "$name@$version" version --json --prefer-online --registry="$NPM_REGISTRY" --@keicoin:registry="$NPM_REGISTRY" > "$view_output" 2> "$view_error"; then
    npm view "$name@$version" dist.integrity --json --prefer-online --registry="$NPM_REGISTRY" --@keicoin:registry="$NPM_REGISTRY" > "$view_output"
    registry_integrity=$(node -e "const fs=require('fs');const v=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(typeof v!=='string')process.exit(2);process.stdout.write(v)" "$view_output")
    if [ "$registry_integrity" != "$local_integrity" ]; then
      echo "release refused: $name@$version exists with different tarball integrity" >&2
      exit 1
    fi
    echo "==> $name@$version is already published and its artifact matches; skipping"
    continue
  elif ! grep -q 'E404' "$view_error"; then
    cat "$view_error" >&2
    echo "release refused: could not determine registry state for $name@$version" >&2
    exit 1
  fi

  echo "==> Publishing $name@$version"
  if [ -n "$OTP" ]; then
    npm publish "$PACK_TMP/$filename" --access public --registry="$NPM_REGISTRY" --@keicoin:registry="$NPM_REGISTRY" --otp "$OTP"
  else
    npm publish "$PACK_TMP/$filename" --access public --registry="$NPM_REGISTRY" --@keicoin:registry="$NPM_REGISTRY"
  fi
done

echo
echo "Published. Check one:"
echo "  npm view kei-transaction"
