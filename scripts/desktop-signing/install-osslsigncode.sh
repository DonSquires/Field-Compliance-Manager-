#!/usr/bin/env bash
# Build osslsigncode against OpenSSL 3 and install it to /usr/local/bin.
#
# Why not apt: Ubuntu 20.04 ships osslsigncode 2.0, which has no `-CAfile`, and its libssl is 1.1.1, which refuses
# to treat FCM's self-signed end-entity signing certificate (CA:FALSE, keyUsage digitalSignature) as its own trust
# anchor — verification fails with "unable to get local issuer certificate" although the signature is sound.
# OpenSSL 3 accepts such an anchor, so the tool is linked against the OpenSSL 3 that conda already provides in
# the dev container (/opt/conda), or against $OPENSSL_ROOT_DIR when set.
set -euo pipefail

VERSION="${OSSLSIGNCODE_VERSION:-2.9}"
# GitHub's archive of tag 2.9, hashed 2026-09-20. A changed hash means a changed upstream tarball: stop and look.
SHA256="${OSSLSIGNCODE_SHA256:-3fe5488e442ad99f91410efeb7b029275366b5df9aa02371dcc89a8f8569ff55}"
OPENSSL_ROOT="${OPENSSL_ROOT_DIR:-/opt/conda}"
PREFIX="${PREFIX:-/usr/local}"

if [[ ! -f "$OPENSSL_ROOT/lib/libcrypto.so.3" && ! -f "$OPENSSL_ROOT/lib64/libcrypto.so.3" ]]; then
  echo "install-osslsigncode: no OpenSSL 3 under $OPENSSL_ROOT (set OPENSSL_ROOT_DIR)" >&2
  exit 1
fi

SUDO=""
if [[ ! -w "$PREFIX/bin" ]]; then SUDO="sudo -n"; fi
$SUDO apt-get install -y -qq cmake libcurl4-openssl-dev zlib1g-dev pkg-config >/dev/null

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL -o "$WORK/src.tgz" "https://github.com/mtrojnar/osslsigncode/archive/refs/tags/${VERSION}.tar.gz"
echo "$SHA256  $WORK/src.tgz" | sha256sum -c - >/dev/null
mkdir "$WORK/src" && tar -xzf "$WORK/src.tgz" -C "$WORK/src" --strip-components=1
# The container's cmake is 3.16; the project asks for 3.17 without using anything newer.
sed -i 's/cmake_minimum_required(VERSION 3.17)/cmake_minimum_required(VERSION 3.16)/' "$WORK/src/CMakeLists.txt"
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release \
  -DOPENSSL_ROOT_DIR="$OPENSSL_ROOT" -DCMAKE_BUILD_RPATH="$OPENSSL_ROOT/lib" -DCMAKE_INSTALL_RPATH="$OPENSSL_ROOT/lib" >/dev/null
cmake --build "$WORK/build" -j"$(nproc)" >/dev/null
$SUDO install -m 0755 "$WORK/build/osslsigncode" "$PREFIX/bin/osslsigncode"
hash -r 2>/dev/null || true
"$PREFIX/bin/osslsigncode" --version 2>&1 | head -2
"$PREFIX/bin/osslsigncode" --version 2>&1 | grep -q "OpenSSL 3" || { echo "install-osslsigncode: built binary is not using OpenSSL 3" >&2; exit 1; }
