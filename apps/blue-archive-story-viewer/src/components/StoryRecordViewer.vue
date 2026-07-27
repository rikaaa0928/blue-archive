<template>
  <div class="record-container" ref="playerContainerElement">
    <div v-if="!ready" style="color: white; font-size: 24px;">Loading...</div>
    <story-player
      v-if="showPlayer && !playEnded"
      class="record-player"
      @initiated="handleInitiated"
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
      @end="handleStoryEnd"
    />
  </div>
</template>

<script setup lang="ts">
import StoryPlayer from "ba-story-player";
import { computed, ref, ComputedRef, onMounted } from "vue";
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

const story = ref<StoryContent>({} as StoryContent);
const storySummaryRaw = ref<Section | undefined>();
const settingsStore = useSettingsStore();
const userName = computed(() => settingsStore.getUsername);
const playerContainerElement = ref<HTMLElement>();
const userLanguage = computed(() => settingsStore.getLang);
const playerLanguage = computed(() =>
  capitalize(settingsStore.getLang)
) as ComputedRef<"Cn" | "Jp" | "En" | "Tw">;

const playEnded = ref(false);
const ready = ref(false);
const showPlayer = ref(false);
const summary = ref({ chapterName: "", summary: "" });

const { width: containerWidth, height: containerHeight } = useElementSize(playerContainerElement);
const playerWidth = ref(1920);
const playerHeight = ref(1080);
const useMp3 = computed(() => settingsStore.getUseMp3);

function handleInitiated() {
  // ready to play
}

function handleStoryEnd() {
  playEnded.value = true;
  (window as any).__STORY_ENDED__ = true;
}

onMounted(() => {
  playerWidth.value = window.innerWidth;
  playerHeight.value = window.innerHeight;
});

getStoryJson(
  storyQueryType.value,
  { storyId: storyId.value },
  () => {}
).then(res => {
  story.value = res.story as StoryContent;
  showPlayer.value = true;
  ready.value = true;
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
