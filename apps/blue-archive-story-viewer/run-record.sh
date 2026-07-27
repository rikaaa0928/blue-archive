#!/bin/bash
set -e

# Make sure we are in the apps/blue-archive-story-viewer directory
cd "$(dirname "$0")"
PROJECT_DIR=$(pwd)
ROOT_DIR=$(dirname $(dirname "$PROJECT_DIR"))

# 编译 ba-story-player 确保底层文件的修改生效
echo "Rebuilding ba-story-player..."
cd "$ROOT_DIR/lib/ba-story-player"
pnpm build

echo "Setting up standalone recording project..."
cd "$PROJECT_DIR"
mkdir -p "$PROJECT_DIR/scripts/record-story"
cd "$PROJECT_DIR/scripts/record-story"
if [ ! -f "package.json" ]; then
  pnpm init
fi
# playwright version can be adjusted
if ! grep -q "playwright" package.json; then
  pnpm install playwright
fi

cd "$PROJECT_DIR"
VITE_PID=""

# Check if port 5173 is accessible at 127.0.0.1
if curl -s http://127.0.0.1:5173 > /dev/null; then
  echo "Vite is already running on 127.0.0.1:5173. Note: If you made changes to the library, you might need to restart Vite manually!"
else
  echo "Starting Vite dev server in the background..."
  # Use host 127.0.0.1 explicitly just in case
  pnpm run dev --host 127.0.0.1 --port 5173 &
  VITE_PID=$!
  echo "Waiting for the dev server to be ready..."
  sleep 5
fi

cd "$PROJECT_DIR/scripts/record-story"
echo "Running the recording script for groupStory/1101..."
node record-story.mjs groupStory/1101

if [ -n "$VITE_PID" ]; then
  echo "Stopping Vite dev server..."
  kill $VITE_PID
fi

echo "Done!"