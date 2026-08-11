#!/bin/bash
set -e

# Make sure we are in the apps/blue-archive-story-viewer directory
cd "$(dirname "$0")"
PROJECT_DIR=$(pwd)
ROOT_DIR=$(dirname "$(dirname "$PROJECT_DIR")")

STORY_PATH="groupStory/1101"
STORY_PATH_SET="false"
HEADLESS="true"
FORCE_RESELECT="false"
SUBTITLE_LANGUAGE="cn"
CLEAR_BROWSER_CACHE="false"

usage() {
  echo "Usage: ./run-record.sh [story-path] [--headless|--no-headless] [--reselect] [--clear-browser-cache] [--subtitle=all|cn|en]"
  echo "Example: ./run-record.sh groupStory/1102 --no-headless --reselect"
  echo "Example: ./run-record.sh eventStory/10014005"
  echo "Example: ./run-record.sh eventStory/10014005 --subtitle=en"
  echo "Default subtitles: Chinese only (--subtitle=cn)"
}

for arg in "$@"; do
  case "$arg" in
    --headless|--headless=true)
      HEADLESS="true"
      ;;
    --no-headless|--headed|--headless=false)
      HEADLESS="false"
      ;;
    --force|--reselect)
      FORCE_RESELECT="true"
      ;;
    --clear-browser-cache)
      CLEAR_BROWSER_CACHE="true"
      ;;
    --subtitle=all|--subtitle=cn|--subtitle=en)
      SUBTITLE_LANGUAGE="${arg#*=}"
      ;;
    --subtitle=*)
      echo "Unsupported subtitle language: ${arg#*=} (expected all, cn, or en)" >&2
      usage >&2
      exit 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ "$STORY_PATH_SET" = "true" ]; then
        echo "Only one story path can be specified." >&2
        usage >&2
        exit 1
      fi
      STORY_PATH="$arg"
      STORY_PATH_SET="true"
      ;;
  esac
done

# Resolve all selection pages before doing the comparatively expensive build.
# Existing valid choices are reused and single-option pages are automatic.
echo "Checking recording pre-selections for $STORY_PATH..."
PRESELECT_ARGS=("$STORY_PATH")
if [ "$FORCE_RESELECT" = "true" ]; then
  PRESELECT_ARGS+=("--force")
fi
node "$PROJECT_DIR/CICD/create-story/preselect-options.mjs" "${PRESELECT_ARGS[@]}"

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
record_variant() {
  local language="$1"
  local output_base
  local final_video
  local trimmed_video
  local sync_metadata
  local trim_seconds
  local browser_cache_args=()

  if [ "$CLEAR_BROWSER_CACHE" = "true" ]; then
    browser_cache_args+=("--clear-browser-cache")
    # With --subtitle=all, clear once before CN and then let EN reuse CN's cache.
    CLEAR_BROWSER_CACHE="false"
  fi

  echo "Running the recording script for $STORY_PATH (headless: $HEADLESS, subtitles: $language)..."
  node record-story.mjs "$STORY_PATH" "--headless=$HEADLESS" "--subtitle=$language" "${browser_cache_args[@]}"

  # Use recording metadata to cut to a stable pre-playback preroll.
  output_base=$(node record-output-path.mjs "$STORY_PATH" "--subtitle=$language")
  final_video="videos/${output_base}.webm"
  trimmed_video="videos/${output_base}.mp4"
  sync_metadata="videos/${output_base}.sync.json"
  mkdir -p "$(dirname "$trimmed_video")"

  if [ -f "$final_video" ]; then
    if [ ! -s "$sync_metadata" ]; then
      echo "Missing recording sync metadata: $sync_metadata" >&2
      return 1
    fi
    trim_seconds=$(node -e '
      const fs = require("fs");
      const metadata = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const trim = Number(metadata.recommendedFinalTrimSeconds);
      if (!Number.isFinite(trim) || trim < 0) process.exit(1);
      process.stdout.write(String(trim));
    ' "$sync_metadata")
    echo "Generating final video (accurate trim: ${trim_seconds}s)..."
    # Accurate cuts between VP8 keyframes require video re-encoding. Encode directly
    # to broadly compatible H.264/AAC MP4 without an intermediate trimmed WebM.
    ffmpeg -y \
      -hide_banner \
      -loglevel warning \
      -stats \
      -ss "$trim_seconds" \
      -i "$final_video" \
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
      "$trimmed_video"
    echo "✅ Final video successfully saved to: $PROJECT_DIR/scripts/record-story/$trimmed_video"
    rm -f "$sync_metadata"
    echo "Deleted consumed recording sync metadata: $sync_metadata"
  fi
}

if [ "$SUBTITLE_LANGUAGE" = "all" ]; then
  SUBTITLE_LANGUAGES=("cn" "en")
else
  SUBTITLE_LANGUAGES=("$SUBTITLE_LANGUAGE")
fi

# Record sequentially to avoid CPU/GPU contention and dropped frames.
for language in "${SUBTITLE_LANGUAGES[@]}"; do
  record_variant "$language"
done

echo "Done!"
