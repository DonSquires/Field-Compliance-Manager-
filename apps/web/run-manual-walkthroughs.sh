#!/usr/bin/env bash

# Manual Walkthrough Test Suite
# =============================
#
# This script runs the "Dr. Bob" style manual walkthroughs that test pages
# like a human would: clicking buttons, filling forms, observing data.
#
# Unlike snapshot tests or pure unit tests, these catch:
# - UI/UX ergonomics issues (cramping, unclear fields)
# - Data flow failures (field persists, related data updates)
# - RLS/FK expansion bugs (permission errors, NULL fields)
# - Missing field writers (Gap 2, Gap 3, etc.)

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "========================================"
echo "Dr. Bob Manual Walkthrough Test Suite"
echo "========================================"
echo ""

# Check if build exists
if [ ! -d "dist" ]; then
    echo "❌ Build not found. Run: npm run build"
    exit 1
fi

echo "✓ Web app build found"
echo ""

# List available manual walkthrough tests
echo "Available manual walkthrough tests:"
echo ""
for test in e2e/*manual-walkthrough*.spec.ts; do
    if [ -f "$test" ]; then
        name=$(basename "$test" .spec.ts)
        if [[ $name == "live-"* ]]; then
          echo "  • $name (🌐 LIVE DEPLOYMENT)"
        else
          echo "  • $name (local fixtures)"
        fi
    fi
done
echo "  • dr-bob-human-test (local fixtures; screenshots + JSON report)"

echo ""
echo "To run a specific test:"
echo "  npx playwright test e2e/crm-portfolio-manual-walkthrough.spec.ts"
echo "  npx playwright test e2e/dr-bob-human-test.spec.ts"
echo ""
echo "To run all manual walkthroughs:"
echo "  npx playwright test e2e/*manual-walkthrough*.spec.ts"
echo ""
echo "To run the human observer against production (read-only exploration):"
echo "  HUMAN_TEST_LIVE=true npx playwright test e2e/dr-bob-human-test.spec.ts"
echo ""
echo "To view the report:"
echo "  npx playwright show-report"
echo ""

# Check Playwright is installed
if ! npx playwright --version > /dev/null 2>&1; then
    echo "❌ Playwright not installed. Run: npm install"
    exit 1
fi

echo "✓ Playwright is installed ($(npx playwright --version 2>&1 | head -1))"
echo ""
echo "Ready to run manual walkthroughs!"
echo ""
echo "Documentation: See docs/MANUAL_TESTING_PLAYBOOK.md and docs/HUMAN_TESTING.md"
