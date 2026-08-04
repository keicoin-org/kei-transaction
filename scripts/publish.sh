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
# skipped rather than failed on, so a run interrupted halfway can just be
# repeated. One code covers the whole run if the run outlives its 30-second
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

cd "$(dirname "$0")/.."

echo "==> Checking release manifests"
npm run release:check

# Dependency order: nothing is published before the thing it imports, so the
# registry never holds a version whose dependencies it cannot serve. Wallet is
# before the two market consumers because it is the other feature-bearing leaf
# in this coordinated release; all three already have their dependencies above.
PACKAGES="core work claims tokens market wallet economy player-economy kei"

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
for package in $PACKAGES; do
  directory="packages/$package"
  name=$(node -p "require('./$directory/package.json').name")
  version=$(node -p "require('./$directory/package.json').version")
  access=$(node -p "require('./$directory/package.json').publishConfig?.access ?? ''")
  if [ "$access" != "public" ]; then
    echo "release refused: $name@$version must declare publishConfig.access=public" >&2
    exit 1
  fi
  pack_json=$(npm pack --dry-run --json "./$directory")
  printf '%s' "$pack_json" | node scripts/check-pack.mjs "$name" "$version"
done

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "Preflight passed. Nothing was published."
  exit 0
fi

for package in $PACKAGES; do
  directory="packages/$package"
  name=$(node -p "require('./$directory/package.json').name")
  version=$(node -p "require('./$directory/package.json').version")

  # --prefer-online, because a 404 from before the first publish is cached, and a
  # stale "not published" is the one wrong answer that makes this loop fail.
  if npm view "$name@$version" version --prefer-online >/dev/null 2>&1; then
    echo "==> $name@$version is already published — skipping"
    continue
  fi

  echo "==> Publishing $name@$version"
  if [ -n "$OTP" ]; then
    (cd "$directory" && npm publish --access public --otp "$OTP")
  else
    (cd "$directory" && npm publish --access public)
  fi
done

echo
echo "Published. Check one:"
echo "  npm view kei-transaction"
echo "  npm create kei-game@latest my-game -- --currency 'Gold Pieces' --yes"
