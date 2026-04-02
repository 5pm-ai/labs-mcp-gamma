#!/bin/bash
set -e

echo "=============================================="
echo "End-to-End Test Suite - All Modes"
echo "=============================================="
echo ""

# Forward all flags (e.g. --live)
FLAGS=""
for arg in "$@"; do
  case "$arg" in
    internal|external|all) MODE="$arg" ;;
    *) FLAGS="$FLAGS $arg" ;;
  esac
done
MODE="${MODE:-all}"

case "$MODE" in
    internal)
        echo "🔧 Running INTERNAL mode tests only..."
        bash scripts/test-e2e-internal.sh $FLAGS
        ;;
    external)
        echo "🔧 Running EXTERNAL mode tests only..."
        bash scripts/test-e2e-external.sh $FLAGS
        ;;
    all|"")
        echo "🔧 Running tests for ALL modes..."
        echo ""

        echo "▶️  Testing INTERNAL mode..."
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        if bash scripts/test-e2e-internal.sh $FLAGS; then
            INTERNAL_RESULT="✅ PASSED"
        else
            INTERNAL_RESULT="❌ FAILED"
        fi

        echo ""
        echo ""

        echo "▶️  Testing EXTERNAL mode..."
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        if bash scripts/test-e2e-external.sh $FLAGS; then
            EXTERNAL_RESULT="✅ PASSED"
        else
            EXTERNAL_RESULT="❌ FAILED"
        fi

        echo ""
        echo "=============================================="
        echo "E2E TEST SUITE SUMMARY"
        echo "=============================================="
        echo "Internal Mode: $INTERNAL_RESULT"
        echo "External Mode: $EXTERNAL_RESULT"
        echo ""

        if [[ "$INTERNAL_RESULT" == *"FAILED"* ]] || [[ "$EXTERNAL_RESULT" == *"FAILED"* ]]; then
            echo "❌ Some tests failed"
            exit 1
        else
            echo "✅ All tests passed!"
        fi
        ;;
    *)
        echo "❌ Invalid mode: $MODE"
        echo "Usage: $0 [internal|external|all] [--live]"
        echo ""
        echo "Modes:"
        echo "  internal - Test internal auth mode only"
        echo "  external - Test external auth mode only"
        echo "  all      - Test both modes (default)"
        echo ""
        echo "Flags:"
        echo "  --live   - Test against running local stack (no build/start/kill)"
        exit 1
        ;;
esac
