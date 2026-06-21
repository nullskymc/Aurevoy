#!/usr/bin/env bash
# 将 web-ui 构建产物同步到 Android 项目 assets
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_UI_DIR="$ROOT/packages/web-ui"
ANDROID_ASSETS="$ROOT/apps/android/app/src/main/assets/web"

echo "==> Building web-ui..."
cd "$WEB_UI_DIR"
npm run build:web

echo "==> Copying to Android assets..."
rm -rf "$ANDROID_ASSETS"
cp -r dist-web "$ANDROID_ASSETS"

echo "==> Done! Assets synced to $ANDROID_ASSETS"
echo "    Files: $(find "$ANDROID_ASSETS" -type f | wc -l)"
