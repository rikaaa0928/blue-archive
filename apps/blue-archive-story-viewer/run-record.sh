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

cleanup() {
  if [ -n "$VITE_PID" ] && kill -0 "$VITE_PID" 2>/dev/null; then
    echo "Stopping Vite dev server..."
    kill "$VITE_PID" 2>/dev/null || true

    # Give Vite a moment to shut down cleanly before using SIGKILL as a fallback.
    for _ in {1..20}; do
      if ! kill -0 "$VITE_PID" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done

    if kill -0 "$VITE_PID" 2>/dev/null; then
      echo "Vite did not stop after SIGTERM; forcing it to exit..."
      kill -9 "$VITE_PID" 2>/dev/null || true
    fi

    wait "$VITE_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Check if port 5173 is accessible at 127.0.0.1
if curl -s http://127.0.0.1:5173 > /dev/null; then
  echo "Vite is already running on 127.0.0.1:5173. Note: If you made changes to the library, you might need to restart Vite manually!"
else
  echo "Starting Vite dev server in the background..."
  # Start Vite directly so $! is the actual Vite process rather than pnpm.
  ./node_modules/.bin/vite --host 127.0.0.1 --port 5173 --strictPort &
  VITE_PID=$!
  echo "Waiting for the dev server to be ready..."
  for _ in {1..60}; do
    if curl -s http://127.0.0.1:5173 > /dev/null; then
      break
    fi
    if ! kill -0 "$VITE_PID" 2>/dev/null; then
      echo "Vite exited before the dev server became ready." >&2
      exit 1
    fi
    sleep 0.25
  done

  if ! curl -s http://127.0.0.1:5173 > /dev/null; then
    echo "Timed out waiting for Vite to become ready." >&2
    exit 1
  fi
fi

cd "$PROJECT_DIR/scripts/record-story"
STORY_PATH="groupStory/1101"
echo "Running the recording script for $STORY_PATH..."
node record-story.mjs $STORY_PATH

# 额外生成一个剪掉前1.5秒内容的新视频
VIDEO_NAME=$(echo $STORY_PATH | tr '/' '_')
FINAL_VIDEO="videos/${VIDEO_NAME}.webm"
TRIMMED_VIDEO="videos/${VIDEO_NAME}_trimmed.mp4"

if [ -f "$FINAL_VIDEO" ]; then
  echo "Generating trimmed video (cutting first 1.5 seconds)..."
  # Accurate cuts between VP8 keyframes require video re-encoding. Encode directly
  # to broadly compatible H.264/AAC MP4 without an intermediate trimmed WebM.
  ffmpeg -y \
    -hide_banner \
    -loglevel warning \
    -stats \
    -ss 1.5 \
    -i "$FINAL_VIDEO" \
    -map 0:v:0 \
    -map 0:a? \
    -vf "setpts=PTS-STARTPTS" \
    -c:v libx264 \
    -preset veryfast \
    -crf 18 \
    -pix_fmt yuv420p \
    -c:a aac \
    -b:a 192k \
    -movflags +faststart \
    "$TRIMMED_VIDEO"
  echo "✅ Trimmed video successfully saved to: $PROJECT_DIR/scripts/record-story/$TRIMMED_VIDEO"
fi

echo "Done!"
