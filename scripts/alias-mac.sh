#!/bin/bash
# Runs at the end of `npm run ship`. Two jobs for the macOS build:
#  1. refresh the versionless "always-latest" alias (Backbone-mac.dmg)
#  2. re-point the originally-shared v0.1.14 link to this build (people already
#     have that link, so it must keep serving the newest app)
set -e
REPO=emailtarun/backbone
VER=$(node -p "require('./package.json').version")
TAG="v$VER"
DMG="dist/Backbone-${VER}-arm64.dmg"

cp "$DMG" dist/Backbone-mac.dmg
gh release upload "$TAG" --repo "$REPO" dist/Backbone-mac.dmg --clobber

cp "$DMG" dist/Backbone-0.1.14-arm64.dmg
gh release upload v0.1.14 --repo "$REPO" dist/Backbone-0.1.14-arm64.dmg --clobber

echo "✓ mac always-latest alias + v0.1.14 link updated to $TAG"
