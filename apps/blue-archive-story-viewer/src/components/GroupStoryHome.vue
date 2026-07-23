<template>
  <div class="fill-screen center" v-if="!storySelected">
    <div class="content-wrapper flex-vertical rounded-small">
      社团剧情在做了在做了
    </div>
    <img class="hire" src="@assets/be_patient.webp" alt="代码滞销帮帮我们" />
  </div>
  <router-view v-else />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";

const route = useRoute();
const storySelected = computed(() => !/\/groupStory\/?$/.test(route.path));
</script>

<style scoped>
img.hire {
  margin: 0 auto;
  max-width: 20rem;
}
</style>
