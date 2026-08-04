<template>
  <div ref="playerContainerElement" class="record-container">
    <div v-if="!ready" style="color: white; font-size: 24px;">Loading...</div>
    <story-player
      v-if="showPlayer && !playEnded"
      class="record-player"
      :story="story"
      :width="playerWidth"
      :height="playerHeight"
      data-url="https://yuuka.cdn.diyigemt.com/image/ba-all-data"
      :language="playerLanguage"
      :userName="userName"
      :story-summary="summary"
      :start-full-screen="false"
      :use-mp3="useMp3"
      :record-mode="true"
      :defer-playback="waitForCapture"
      :record-selections="recordSelections"
      @initiated="handleInitiated"
      @end="handleStoryEnd"
      @error="handleStoryError"
    />
  </div>
</template>

<script setup lang="ts">
import StoryPlayer from "ba-story-player";
import { computed, ref, ComputedRef, onBeforeUnmount, onMounted } from "vue";
import { useRoute } from "vue-router";
import { Section, StoryContent } from "@/types/StoryJson";
import { useSettingsStore } from "@store/settings";
import { useElementSize } from "@vueuse/core";
import { capitalize } from "radash";
import "ba-story-player/dist/style.css";
import {
  getStoryJson,
  getStorySummary,
  type QueryType,
} from "@/util/playerUtils";

const route = useRoute();
const storyId = computed(() => route.params.id as string);
const storyQueryType = computed<QueryType>(() => route.params.type as QueryType);
const waitForCapture = route.query.captureHandshake === "1";

const story = ref<StoryContent>({} as StoryContent);
const storySummaryRaw = ref<Section | undefined>();
const settingsStore = useSettingsStore();
const userName = computed(() => settingsStore.getUsername);
const playerContainerElement = ref<HTMLElement>();
const subtitleLanguage = computed(() => {
  const requestedLanguage = route.query.subtitleLanguage;
  return requestedLanguage === "cn" || requestedLanguage === "en"
    ? requestedLanguage
    : settingsStore.getLang;
});
const playerLanguage = computed(() =>
  capitalize(subtitleLanguage.value)
) as ComputedRef<"Cn" | "Jp" | "En" | "Tw">;

const playEnded = ref(false);
const ready = ref(false);
const showPlayer = ref(false);
const playerInitiated = ref(false);
let startDeferredPlayback: (() => void) | undefined;
let playbackStarted = false;
const summary = ref({ chapterName: "", summary: "" });

const { width: containerWidth, height: containerHeight } = useElementSize(playerContainerElement);
const playerWidth = ref(1920);
const playerHeight = ref(1080);
const useMp3 = computed(() => settingsStore.getUseMp3);
const recordSelections = computed(() => {
  const rawSelections = route.query.recordSelections;
  if (typeof rawSelections !== "string") {
    return {};
  }

  try {
    return Object.fromEntries(
      (
        JSON.parse(rawSelections) as Array<{
          storyIndex: number;
          selectionGroup: number;
        }>
      ).map(selection => [
        selection.storyIndex,
        selection.selectionGroup,
      ])
    );
  } catch (error) {
    console.error("Invalid recording pre-selections:", error);
    return {};
  }
});

function handleInitiated(startPlayback: () => void) {
  startDeferredPlayback = startPlayback;
  playerInitiated.value = true;
  (window as any).__STORY_PLAYER_READY__ = true;
}

function startPlayback() {
  if (playbackStarted || !playerInitiated.value) {
    return;
  }
  playbackStarted = true;
  startDeferredPlayback?.();
  (window as any).__STORY_RECORDING_STARTED__ = true;
}

function handleStoryEnd() {
  playEnded.value = true;
  (window as any).__STORY_ENDED__ = true;
}

function handleStoryError(error: unknown) {
  (window as any).__STORY_ERROR__ =
    error instanceof Error
      ? error.stack || error.message
      : String(error || "Unknown error");
}

onMounted(() => {
  playerWidth.value = window.innerWidth;
  playerHeight.value = window.innerHeight;
  (window as any).__START_STORY_RECORDING__ = startPlayback;
});

onBeforeUnmount(() => {
  delete (window as any).__START_STORY_RECORDING__;
});

getStoryJson(
  storyQueryType.value,
  { storyId: storyId.value },
  () => {}
).then(res => {
  story.value = res.story as StoryContent;
  ready.value = true;
  showPlayer.value = true;
});

getStorySummary(storyQueryType.value, {
  directoryId: storyId.value,
  storyId: storyId.value,
}).then(res => {
  if (res) {
    summary.value.chapterName = Reflect.get(res as any, "title")?.["Text" + playerLanguage.value] || "";
    summary.value.summary = Reflect.get(res as any, "abstract")?.["Text" + playerLanguage.value] || "";
  }
});

</script>

<style scoped lang="scss">
.record-container {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background-color: black;
  z-index: 999999;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
}

.record-player {
  width: 100%;
  height: 100%;
}

</style>
