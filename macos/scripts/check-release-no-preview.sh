#!/bin/bash
# Proves the fixture backed preview mode is compiled out of Release: builds Release and fails if any
# preview marker string or symbol is present in the shipped binaries.
set -euo pipefail
cd "$(dirname "$0")/.."
DD="${DD:-$(mktemp -d)}"
xcodebuild -scheme TaifaMail -configuration Release -destination 'platform=macOS' -derivedDataPath "$DD" build >/dev/null
APP="$DD/Build/Products/Release/TaifaMail.app"
status=0
for f in "$APP"/Contents/MacOS/*; do
  for marker in TaifaPreviewData TaifaPreviewState PreviewFixtures PreviewMailService startPreview example.go.ke; do
    if strings -a "$f" | grep -q "$marker"; then echo "FOUND $marker in $(basename "$f")"; status=1; fi
    if nm "$f" 2>/dev/null | grep -q "$marker"; then echo "FOUND symbol $marker in $(basename "$f")"; status=1; fi
  done
done
[ $status -eq 0 ] && echo "OK: no preview code in the Release build ($APP)"
exit $status
