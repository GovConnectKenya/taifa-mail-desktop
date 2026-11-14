#!/bin/bash
# Vendors the Iconsax SVGs the app uses (rounded/linear) into the asset catalog,
# one imageset per icon. Re-run only when the icon list changes. The library
# path is a build-time input only; nothing references it at runtime.
set -euo pipefail
LIB="${ICON_LIB:-/Users/user/projects/hicon/icon-library/icons/rounded/linear}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/TaifaMail/Assets.xcassets/Icons"
rm -rf "$OUT"; mkdir -p "$OUT"
cat > "$OUT/Contents.json" <<J
{ "info": { "author": "xcode", "version": 1 }, "properties": { "provides-namespace": false } }
J
add() { # name category file-stem-prefix
  local name="$1" cat="$2" file="$3"
  local src; src="$(ls "$LIB/$cat/$file"-*-.svg 2>/dev/null | grep -E "/$file-[0-9a-f]{12}-\.svg$" | head -1)"
  [ -n "$src" ] || { echo "missing $cat/$file" >&2; exit 1; }
  local dir="$OUT/icon-$name.imageset"; mkdir -p "$dir"
  cp "$src" "$dir/$name.svg"
  cat > "$dir/Contents.json" <<J
{
  "images": [ { "filename": "$name.svg", "idiom": "universal" } ],
  "info": { "author": "xcode", "version": 1 },
  "properties": { "preserves-vector-representation": true, "template-rendering-intent": "template" }
}
J
}
add chevron-down arrow iconsax-arrow-down4
add chevron-up arrow iconsax-arrow-up3
add chevron-right arrow iconsax-arrow-right4
add chevron-left arrow iconsax-arrow-left3
add star space2new iconsax-star
add open-mail email iconsax-open-mail
add link blockchain iconsax-connect-links
add list health iconsax-list
add inbox email iconsax-inbox
add drafts email iconsax-pending-mail
add sent email iconsax-sent-mails
add archive essential iconsax-archive
add junk email iconsax-spam-mail
add trash essential iconsax-trash
add folder files iconsax-folder-open
add flag essential iconsax-flag
add attachment email iconsax-attached-file
add reply email iconsax-reply
add reply-all email iconsax-reply-mail
add forward email iconsax-forward
add compose mobile iconsax-edit
add refresh arrow iconsax-refresh-right
add search search iconsax-search-normal
add settings security iconsax-settings
add user user iconsax-profile
add unread email iconsax-unread-mail
add close essential iconsax-close-circle
add check essential iconsax-tick-circle
add download network iconsax-download-cloud
add undo arrow iconsax-undo-arrow
add sidebar programming iconsax-sidebar-left
add warning essential iconsax-warning
add info essential iconsax-info-circle
add wifi telephonenew iconsax-wifi
add send email iconsax-send-mail
add more essential iconsax-more-circle
add image-off security iconsax-eye-slash
add mail email iconsax-mail
add bell essential iconsax-bell
add danger essential iconsax-danger
add lock security iconsax-shield
echo "vendored $(ls "$OUT" | grep -c imageset) icons"
