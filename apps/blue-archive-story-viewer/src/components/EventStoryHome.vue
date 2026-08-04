<template>
  <div
    v-if="!isStorySelected"
    class="main-story-container fill-screen flex-vertical"
  >
    <div
      v-for="group in groupedStories"
      :key="group.place"
      class="w-full max-w-[480px] flex flex-col items-start"
    >
      <h3 class="mb-2 sticky top-0">
        {{ getPlaceName(group.place, userLanguage) }}
      </h3>

      <story-line-container
        v-for="(story, index) in group.stories"
        :key="index"
        :title="story.title"
        :avatar="story.avatar"
        :index="index"
        :sections="story.sections"
        type="eventStory"
      />
    </div>
  </div>
  <router-view v-else />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import StoryLineContainer from "./story/StoryLineContainer.vue";
import { stories, placeMap, type PlaceMap } from "@index/eventStoryIndex";
import { group, capitalize } from "radash";
import { useSettingsStore } from "@store/settings";
import { Language } from "@/types/Settings";
const settingsStore = useSettingsStore();
const userLanguage = computed(() => settingsStore.getLang);
const route = useRoute();
// TODO：整理路由
const isStorySelected = computed(() => !/\/eventStory\/?$/.test(route.path));

// volar类型推断失败
// @ts-ignore
const groupedStories = computed(() =>
  Object.entries(group(stories, el => el.place)).map(([key, value]) => ({
    place: key,
    stories: value,
  }))
);

function getPlaceName(place: string, language: Language) {
  const placeItem = placeMap.find(p => p.code === place);
  if (!placeItem) return place;

  return Reflect.get(placeItem, `Text${capitalize(language)}`);
}
</script>

<style scoped lang="scss">
.main-story-container {
  margin-top: 24px;
}
</style>
