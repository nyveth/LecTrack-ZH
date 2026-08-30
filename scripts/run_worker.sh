#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

cuda_library_path="$(
    uv run python -c '
import nvidia.cublas.lib
import nvidia.cudnn.lib

print(
    next(iter(nvidia.cublas.lib.__path__))
    + ":"
    + next(iter(nvidia.cudnn.lib.__path__))
)
'
)"

export LD_LIBRARY_PATH="${cuda_library_path}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
exec uv run python -m app.worker "$@"
