#!/bin/bash
set -euo pipefail

{
  echo "=== TREE ==="
  git ls-files

  echo -e "\n=== README last touched ==="
  git log -1 --format='%h %ad %s' --date=short -- README.md

  echo -e "\n=== FILES ==="
  git ls-files | grep -E \
    -e '^(app|scripts|tests)/.+\.py$' \
    -e '^scripts/.+\.sh$' \
    -e '^frontend/app/.+\.(tsx|ts)$' \
    -e '^\.github/workflows/.+\.ya?ml$' \
    -e '^(pyproject\.toml|\.env\.example|frontend/package\.json)$' \
  | while IFS= read -r f; do
      echo -e "\n--- $f ---"
      cat "$f"
    done
} > snapshot.txt

wc -l snapshot.txt