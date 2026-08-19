#!/usr/bin/env bash
# Build all bundles, stage server+webview inside packages/client/bundled/, then build a .vsix.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> building bundles"
bun run build:server
bun run build:client
bun run build:webview

CLIENT=packages/client
BUNDLED="$CLIENT/bundled"
echo "==> staging bundles into $BUNDLED/"
rm -rf "$BUNDLED"
mkdir -p "$BUNDLED/server" "$BUNDLED/webview"
cp packages/server/dist/server.js "$BUNDLED/server/server.js"
cp packages/webview/dist/webview.js "$BUNDLED/webview/webview.js"
cp packages/webview/dist/webview.css "$BUNDLED/webview/webview.css"

echo "==> staging README.md into $CLIENT/"
cp README.md "$CLIENT/README.md"

echo "==> running vsce package"
cd "$CLIENT"
bunx vsce package --no-dependencies --allow-missing-repository -o ../../gitlab-ci-preview.vsix

cd ../..
ls -la gitlab-ci-preview.vsix

echo ""
echo "==> cleaning staged bundled/ and README.md so dev mode (F5) uses live dist/ paths"
rm -rf "$BUNDLED"
rm -f "$CLIENT/README.md"
echo ""
echo "Install in Kiro:"
echo "  Command Palette → 'Extensions: Install from VSIX...' → pick $(pwd)/gitlab-ci-preview.vsix"
echo "Or from terminal (if 'kiro' CLI exists):"
echo "  kiro --install-extension $(pwd)/gitlab-ci-preview.vsix"
