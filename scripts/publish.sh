#!/usr/bin/env sh
#
# Publish the workspace to npm, in dependency order.
#
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

# Optional: an account whose 2FA is a security key has no six-digit code to give,
# and an account that does not require 2FA for writes does not need one either.
OTP="${1:-${NPM_OTP:-}}"

cd "$(dirname "$0")/.."

# Dependency order: nothing is published before the thing it imports, so the
# registry never holds a version whose dependencies it cannot serve.
PACKAGES="core work claims tokens wallet kei create-kei-game"

echo "==> Building"
npm run build

echo "==> Testing"
npm test

for package in $PACKAGES; do
  directory="packages/$package"
  name=$(node -p "require('./$directory/package.json').name")
  version=$(node -p "require('./$directory/package.json').version")

  if npm view "$name@$version" version >/dev/null 2>&1; then
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
