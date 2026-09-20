#!/usr/bin/env bash
# Runs once after the devcontainer is (re)built. /home is recreated on rebuild, so anything the e2e suite needs
# outside /workspaces is restored here: Playwright's Chromium and the font set the screenshot baselines were rendered
# with (DejaVu alone changes glyph metrics enough to push full-page snapshots past the 3% tolerance).
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v sudo >/dev/null && sudo -n true 2>/dev/null; then
  # the image ships a yarn apt source whose signing key is gone; it breaks every apt-get update
  sudo -n rm -f /etc/apt/sources.list.d/yarn.list
  sudo -n apt-get update -qq || true
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    fonts-liberation fonts-noto-color-emoji fonts-freefont-ttf fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf ttf-unifont \
    >/dev/null || echo "fonts: install skipped (apt unavailable)"
  fc-cache -f >/dev/null 2>&1 || true
fi

if [ -d apps/web/node_modules ]; then
  (cd apps/web && npx playwright install chromium >/dev/null 2>&1) || echo "playwright: browser install skipped"
fi
echo "post-create: fonts $(fc-list : family 2>/dev/null | sort -u | wc -l) families, deno $(command -v deno >/dev/null && deno --version | head -1 || echo missing)"
