#!/bin/bash
# Build script for Capacitor Android
# Copies webapp files to public/ and syncs with Android project

set -e

echo "📦 Building FoxPot Club for Capacitor..."

# Clean public
rm -rf public/*
mkdir -p public/icons

# Copy webapp as index.html
cp webapp.html public/index.html

# Copy static assets
cp manifest.json public/
cp sw.js public/
cp offline.html public/
cp icons/*.png public/icons/ 2>/dev/null || true

echo "✅ Files copied to public/"

# Sync with Android
npx cap sync android

echo "🤖 Android synced! Open with: npx cap open android"
