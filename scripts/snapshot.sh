
{
  echo "=== TREE ==="
  git ls-files | grep -E '\.(py|toml|md)$' | grep -v '\.venv'
  echo -e "\n=== FILES ==="
  git ls-files 'app/*.py' 'app/core/*.py' | while read f; do
    echo -e "\n--- $f ---"
    cat "$f"
  done
} > snapshot.txt