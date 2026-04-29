#!/bin/bash
# Finalize distributable macOS DMG artifacts.
#
# Order matters:
#   1. codesign the final DMG container
#   2. notarize the signed DMG
#   3. staple the notarization ticket
#   4. validate with stapler and Gatekeeper
#   5. regenerate blockmaps after the DMG bytes are final
#
# Usage:
#   APPLE_NOTARY_PROFILE=hanako-notary scripts/finalize-macos-dmg.sh dist/Lynn-0.77.1-macOS-Apple-Silicon.dmg dist/Lynn-0.77.1-macOS-Intel.dmg

set -euo pipefail

cd "$(dirname "$0")/.."

IDENTITY="${APPLE_SIGN_IDENTITY:-Developer ID Application: Yubo Xu (KYB8UN3JP3)}"
NOTARY_PROFILE="${APPLE_NOTARY_PROFILE:-${NOTARY_KEYCHAIN_PROFILE:-}}"
APP_BUILDER="${APP_BUILDER_BIN:-node_modules/app-builder-bin/mac/app-builder_arm64}"

if [[ -z "$NOTARY_PROFILE" ]]; then
  echo "Set APPLE_NOTARY_PROFILE or NOTARY_KEYCHAIN_PROFILE before finalizing DMGs." >&2
  exit 1
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: APPLE_NOTARY_PROFILE=hanako-notary $0 <dmg> [<dmg> ...]" >&2
  exit 1
fi

if [[ ! -x "$APP_BUILDER" ]]; then
  echo "Missing app-builder binary: $APP_BUILDER" >&2
  exit 1
fi

for dmg in "$@"; do
  if [[ ! -f "$dmg" ]]; then
    echo "Missing DMG: $dmg" >&2
    exit 1
  fi

  echo "==> Signing final DMG: $dmg"
  codesign --force --sign "$IDENTITY" --timestamp --options runtime "$dmg"
  codesign --verify --verbose "$dmg"

  echo "==> Notarizing final DMG with profile: $NOTARY_PROFILE"
  xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait

  echo "==> Stapling final DMG: $dmg"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"

  echo "==> Gatekeeper validation: $dmg"
  spctl -a -vv -t open --context context:primary-signature "$dmg"

  echo "==> Rebuilding blockmap after final bytes: $dmg.blockmap"
  "$APP_BUILDER" blockmap --input "$dmg" --output "$dmg.blockmap"
done

echo "All macOS DMGs are signed, notarized, stapled, Gatekeeper-validated, and blockmap-refreshed."
