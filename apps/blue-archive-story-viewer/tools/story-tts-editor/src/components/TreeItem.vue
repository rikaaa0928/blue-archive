<template>
  <div class="tree-item-container">
    <div v-if="isFolder" class="folder" @click="toggle">
      <span class="icon">{{ item.isOpen ? '▼' : '▶' }}</span>
      <span class="name">{{ item.name }}</span>
    </div>
    <div
      v-else
      class="file story-item"
      :class="{ active: activeStory && activeStory.path === item.path }"
      @click="selectStory(item)"
    >
      📄 {{ item.id }}
    </div>

    <div v-if="isFolder && item.isOpen" class="children">
      <TreeItem
        v-for="(child, idx) in item.children"
        :key="idx"
        :item="child"
        :active-story="activeStory"
        @select-story="selectStory"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  item: any;
  activeStory: any;
}>();

const emit = defineEmits(['select-story']);

const isFolder = computed(() => props.item.type === 'folder');

function toggle() {
  if (isFolder.value) {
    props.item.isOpen = !props.item.isOpen;
  }
}

function selectStory(story: any) {
  emit('select-story', story);
}
</script>

<style scoped>
.tree-item-container {
  font-size: 14px;
}
.folder {
  cursor: pointer;
  padding: 4px 0;
  display: flex;
  align-items: center;
  user-select: none;
}
.folder:hover {
  background-color: #f4f4f5;
}
.icon {
  margin-right: 6px;
  font-size: 10px;
  color: #71717a;
  width: 12px;
  text-align: center;
}
.name {
  font-weight: 500;
  color: #3f3f46;
}
.file {
  cursor: pointer;
  padding: 4px 0 4px 18px;
  color: #52525b;
}
.file:hover, .file.active {
  background-color: #e0f2fe;
  color: #0284c7;
}
.children {
  padding-left: 14px;
  border-left: 1px dashed #e4e4e7;
  margin-left: 6px;
}
</style>
