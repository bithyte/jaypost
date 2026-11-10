#!/bin/sh
# Installs the jaypost standalone binary to ~/.local/bin, then runs `jaypost service install`.
# Usage: curl -fsSL https://unpkg.com/jaypost/install.sh | sh
# JAYPOST_RELEASE_URL overrides where the binaries come from (tests use it).
# JAYPOST_INSTALL_DIR overrides where the binary goes, and JAYPOST_NO_INIT=1 skips the install
# (the GitHub Action uses both).
set -eu

release_url="${JAYPOST_RELEASE_URL:-https://github.com/bithyte/jaypost/releases/latest/download}"
bin_dir="${JAYPOST_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "jaypost install: $1" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "no binary for $(uname -s); use npx jaypost service install instead (needs Node 24.15+)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "no binary for $(uname -m); use npx jaypost service install instead (needs Node 24.15+)" ;;
esac

# A shell running under Rosetta reports x86_64 on Apple silicon; the native binary is better
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  arch=arm64
fi

if command -v sha256sum >/dev/null 2>&1; then
  hash_file() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  hash_file() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "needs sha256sum or shasum to check the download"
fi

asset="jaypost-$os-$arch.gz"
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir" "$bin_dir/jaypost.$$.tmp"' EXIT

echo "Downloading $asset"
for file in "$asset" SHA256SUMS; do
  if ! curl -fsSL -o "$temp_dir/$file" "$release_url/$file"; then
    fail "couldn't download $release_url/$file; if a release just came out, its binaries may still be uploading, so try again in a few minutes"
  fi
done

expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$temp_dir/SHA256SUMS")
actual=$(hash_file "$temp_dir/$asset")
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  fail "checksum of $asset doesn't match SHA256SUMS"
fi

# Unpack next to the target and rename, so a running copy is never half-written
mkdir -p "$bin_dir"
gunzip -c "$temp_dir/$asset" >"$bin_dir/jaypost.$$.tmp"
chmod +x "$bin_dir/jaypost.$$.tmp"
mv -f "$bin_dir/jaypost.$$.tmp" "$bin_dir/jaypost"
echo "Installed $bin_dir/jaypost"

if [ "${JAYPOST_NO_INIT:-}" = 1 ]; then
  exit 0
fi

# stdin is this script when piped from curl, so the install prompts need the terminal
if ! (: </dev/tty) 2>/dev/null; then
  echo "No terminal to set it up from; run $bin_dir/jaypost service install"
  exit 0
fi
"$bin_dir/jaypost" service install </dev/tty
