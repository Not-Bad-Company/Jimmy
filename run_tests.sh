#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== Running Rust Tests ==="
cargo test --manifest-path backend/Cargo.toml

echo "=== Running Full-System Automated Verification Suite ==="
services/.venv/bin/python tests/test_full_system.py

echo "=== All Tests Completed Successfully ==="
