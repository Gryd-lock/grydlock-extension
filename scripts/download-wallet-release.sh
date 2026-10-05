#!/usr/bin/env bash
# Fetches a PINNED, unpacked build of a real wallet extension for e2e testing.
# Never points at "latest" for the blocking CI path — see spike §8.
#
# Usage:
#   ./download-wallet-release.sh freighter v5.x.x ./fixtures/wallets/freighter
#   ./download-wallet-release.sh albedo    v1.x.x ./fixtures/wallets/albedo
#
# Caching: CI should key its cache on (wallet, version) so this only actually
# hits the network when a version pin changes (spike §8, §10).

set -euo pipefail

WALLET="${1:?wallet name required: freighter|albedo}"
VERSION="${2:?exact pinned version/tag required, e.g. v5.1.0 — never 'latest'}"
DEST="${3:?destination directory required}"

if [[ -d "$DEST" && -f "$DEST/manifest.json" ]]; then
  echo "[$WALLET $VERSION] already present at $DEST, skipping download."
  exit 0
fi

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$WALLET" in
  freighter)
    REPO="stellar/freighter"
    ;;
  albedo)
    REPO="stellar-expert/albedo"
    ;;
  *)
    echo "Unknown wallet: $WALLET (expected freighter|albedo)" >&2
    exit 1
    ;;
esac

echo "[$WALLET] fetching source at pinned tag $VERSION from $REPO ..."
git clone --depth 1 --branch "$VERSION" "https://github.com/$REPO.git" "$TMP/src"

echo "[$WALLET] NOTE: this clones source, not a pre-built artifact."
echo "         Building requires the wallet repo's own toolchain (yarn workspaces"
echo "         for Freighter). Wire the repo-specific build command here once"
echo "         confirmed — this script intentionally stops short of guessing it,"
echo "         since a wrong build step is worse than an explicit manual TODO."
echo ""
echo "         Once built, copy the produced unpacked extension directory"
echo "         (e.g. extension/build for Freighter) into: $DEST"
echo ""
echo "[$WALLET] recording pinned version metadata at $DEST/.pinned-version"
echo "{\"wallet\": \"$WALLET\", \"version\": \"$VERSION\", \"repo\": \"$REPO\", \"fetched_at\": \"$(date -u +%FT%TZ)\"}" \
  > "$DEST/.pinned-version"

echo "[$WALLET $VERSION] done. Verify $DEST/manifest.json exists before running tests."