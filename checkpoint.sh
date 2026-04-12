#!/bin/bash
# FoxPot Checkpoint — код + дані разом

DATE=$(date +%Y%m%d_%H%M)
NAME=${1:-"checkpoint"}
TAG="checkpoint-${NAME}-${DATE}"

echo "🦊 Creating checkpoint: $TAG"

# 1. Бекап БД
echo "📦 Backing up database..."
mkdir -p backups
pg_dump $DATABASE_URL > "backups/db_${TAG}.sql"

# 2. Git checkpoint
echo "📌 Git checkpoint..."
git add -A
git commit -m "checkpoint: $NAME ($DATE)" --allow-empty
git tag $TAG
git push origin main --tags

echo "✅ Checkpoint done: $TAG"
echo "✅ DB backup: backups/db_${TAG}.sql"
