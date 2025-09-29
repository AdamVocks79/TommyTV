#!/bin/bash
set -e

# Default commit message if none provided
MESSAGE=${1:-"Update TommyTVStats"}

echo "📦 Adding changes..."
git add .

echo "📝 Committing changes..."
git commit -m "$MESSAGE"

echo "⬆️  Pushing to GitHub..."
git push origin main

echo "✅ Code pushed. Server will pick it up on next deploy check."

