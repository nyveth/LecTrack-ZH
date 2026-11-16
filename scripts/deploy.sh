#!/usr/bin/env bash
set -euo pipefail
git push
ssh devserver 'bash -lc "cd ~/projects/rag-bot && git pull --ff-only && uv sync --inexact && sudo systemctl restart rag-bot rag-bot-worker"'
