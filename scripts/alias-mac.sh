#!/bin/bash
# Create/refresh the versionless "always-latest" macOS download alias on this
# version's release. Runs automatically at the end of `npm run ship`.
set -e
REPO=emailtarun/backbone
TAG="v$(node -p "require('./package.json').version")"
DMG=$(ls dist/Backbone-*-arm64.dmg | head -1)
cp "$DMG" dist/Backbone-mac.dmg
gh release upload "$TAG" --repo "$REPO" dist/Backbone-mac.dmg --clobber
echo "✓ Backbone-mac.dmg alias updated on $TAG"
