#!/bin/bash
# Refresh the versionless "always-latest" download aliases on the newest release.
# Run AFTER `npm run ship` AND after CI has published the Windows .exe (~1-2 min).
# These give permanent links that always serve the latest build:
#   https://github.com/emailtarun/backbone/releases/latest/download/Backbone-mac.dmg
#   https://github.com/emailtarun/backbone/releases/latest/download/Backbone-windows.exe
set -e
REPO=emailtarun/backbone
TAG=$(gh release view --repo "$REPO" --json tagName --jq .tagName)
TMP=$(mktemp -d)
echo "Refreshing aliases for $TAG…"
gh release download "$TAG" --repo "$REPO" --pattern "*arm64.dmg" --dir "$TMP"
gh release download "$TAG" --repo "$REPO" --pattern "*Setup*.exe" --dir "$TMP"
cp "$TMP"/*arm64.dmg "$TMP/Backbone-mac.dmg"
cp "$TMP"/*Setup*.exe "$TMP/Backbone-windows.exe"
gh release upload "$TAG" --repo "$REPO" "$TMP/Backbone-mac.dmg" "$TMP/Backbone-windows.exe" --clobber
# Keep the originally-shared v0.1.14 link serving the latest build too.
cp "$TMP"/*arm64.dmg "$TMP/Backbone-0.1.14-arm64.dmg"
cp "$TMP"/*Setup*.exe "$TMP/Backbone-Setup-0.1.14.exe"
gh release upload v0.1.14 --repo "$REPO" "$TMP/Backbone-0.1.14-arm64.dmg" "$TMP/Backbone-Setup-0.1.14.exe" --clobber
rm -rf "$TMP"
echo "✓ Stable aliases + v0.1.14 link now point at $TAG"
