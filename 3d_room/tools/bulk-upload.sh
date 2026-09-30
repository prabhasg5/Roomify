#!/usr/bin/env bash
# Bulk-load furniture into the Roomify catalogue.
#
# One GLB in → workspace mesh (.js) + AR mesh (.glb) + thumbnail + catalogue entry.
# You never author .js by hand; it is a build artifact.
#
#   1. start the server:  cd 3d_room && npm start
#   2. drop .glb files in a folder, one folder per placement type
#   3. ./tools/bulk-upload.sh <folder> [type]
#   4. node tools/build-catalogue.js
#
# type: 1=floor furniture (default) · 2=wall art · 3=window · 7=door · 8=rug
#
# Naming: the filename becomes the product name, so name files the way you want
# them to read. Use " - " for variants — "Sofa - Grey.glb", "Sofa - Linen.glb"
# group into ONE product with two variants automatically.

set -euo pipefail

DIR="${1:-}"
TYPE="${2:-1}"
SERVER="${SERVER:-http://localhost:9000}"

if [ -z "$DIR" ] || [ ! -d "$DIR" ]; then
  echo "usage: $0 <folder-of-glb-files> [type]" >&2
  exit 1
fi

if ! curl -sf -o /dev/null "$SERVER/api/models"; then
  echo "✗ server not reachable at $SERVER — run 'npm start' first" >&2
  exit 1
fi

ok=0; fail=0
shopt -s nullglob nocaseglob
for f in "$DIR"/*.glb "$DIR"/*.gltf; do
  name="$(basename "${f%.*}")"
  printf '  %-40s ' "$name"

  # -F name=... sends the display name; the server slugs it for filenames
  if body=$(curl -sf -X POST "$SERVER/api/upload-model" \
              -F "model=@$f" -F "name=$name" -F "type=$TYPE" 2>/dev/null); then
    echo "ok"
    ok=$((ok+1))
  else
    echo "FAILED"
    fail=$((fail+1))
  fi
done

echo
echo "  $ok uploaded, $fail failed"
[ "$ok" -gt 0 ] && echo "  now run: node tools/build-catalogue.js"
