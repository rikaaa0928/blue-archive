# Story TTS Editor

A local web application to edit and preview `TextJpVoice` for Blue Archive stories and generate temporary TTS audio for immediate review.

## Setup

```bash
cd apps/blue-archive-story-viewer/tools/story-tts-editor
pnpm install
```

## Running

```bash
pnpm start
```

Then visit `http://localhost:5173` in your browser.

## Features

1. **View Stories**: Shows all imported stories from the `public/story` directory.
2. **Read Script**: Displays the speaker, Original Chinese (TextCn), and Original Japanese (TextJp) for reference.
3. **Edit TTS Target**: Shows and edits `TextJpVoice` for each dialogue line.
4. **Current Audio**: Provides a playback button for the current `VoiceJp` audio (which attempts to resolve to your local cached copy).
5. **Test TTS**: Generates temporary audio from the edited `TextJpVoice` and plays it for comparison.
6. **Save Story to Disk**: Persists the edited `TextJpVoice` back into the corresponding story JSON without changing `VoiceJp`.

## Process Flow for Adjusting TTS

1. Find the story you are working on in the sidebar.
2. Enter your TTS URL (e.g. `https://yiling.top/api/tts` or local) and API Key in the top navigation bar.
3. Find the dialogue line you want to improve.
4. Edit the `TextJpVoice` field to adjust the TTS script (e.g. adding punctuation, changing reading marks).
5. Click **Test TTS**. The server will generate a temporary audio file and give you a playback button when done.
6. Repeat the edit-and-preview cycle until the reading sounds right.
7. Click **Save Story to Disk**. This saves the `TextJpVoice` edits only; the temporary audio remains a local preview and `VoiceJp` is left unchanged.
8. Once all text adjustments are made, use the standard TTS publication workflow to generate and publish the final audio.

*Note*: Preview files are written under `temp-audio/` and ignored by Git. They are never attached to story data or published to R2 by this tool.
