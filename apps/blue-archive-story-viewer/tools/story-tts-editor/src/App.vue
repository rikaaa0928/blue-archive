<template>
  <div class="app-container">
    <div class="top-bar">
      <h2>Story TTS Editor</h2>
      <div class="settings" style="display: flex; flex-direction: column; gap: 8px;">
        <div>
          <label>
            ZeroTTS API (for list voices):
            <input type="text" v-model="ttsUrl" placeholder="https://yiling.top/api/tts" style="width: 200px; margin-right: 10px;" />
          </label>
          <label>
            Key:
            <input type="password" v-model="ttsKey" placeholder="ZeroTTS Key" style="width: 120px" />
          </label>
        </div>
        <div>
          <label>
            OpenAI TTS API (for generation):
            <input type="text" v-model="openAiTtsUrl" placeholder="https://tts.api.c.yiling.top/v1" style="width: 200px; margin-right: 10px;" />
          </label>
          <label>
            Key:
            <input type="password" v-model="openAiTtsKey" placeholder="OpenAI TTS Key" style="width: 120px" />
          </label>
          <button @click="saveStory" :disabled="!activeStory || saving" class="primary-btn" style="margin-left: 20px;">
            {{ saving ? 'Saving...' : 'Save Story to Disk' }}
          </button>
        </div>
      </div>
    </div>
    <div class="layout">
      <div class="sidebar">
        <h3>Stories</h3>
        <div v-if="loadingStories">Loading...</div>
        <div class="tree-root" v-else>
          <TreeItem
            v-for="(node, idx) in storyTree"
            :key="idx"
            :item="node"
            :active-story="activeStory"
            @select-story="loadStory"
          />
        </div>
      </div>
      <div class="main-content">
        <div v-if="loadingStory">Loading story data...</div>
        <div v-else-if="activeStoryData">
          <div v-for="(item, index) in dialogItems" :key="index" class="script-line">
            <div class="header">
              [{{ item._originalIndex }}] <span>{{ extractCharacterName(item) || 'Narrator' }}</span>
            </div>

            <div class="text-box" v-if="item.TextCn"><strong>CN:</strong> {{ item.TextCn }}</div>
            <div class="text-box" v-if="item.TextJp"><strong>JP:</strong> {{ item.TextJp }}</div>

            <div class="text-box" v-if="item.VoiceJp">
              <strong>VoiceJp URL (Remote):</strong> <a :href="item.VoiceJp" target="_blank">{{ item.VoiceJp }}</a>
              <br/>
              <audio controls :src="item.VoiceJp" v-if="item.VoiceJp" preload="none" style="height: 32px; margin-bottom: 8px;"></audio>

              <br/>
              <strong>Local Cached Audio:</strong>
              <br/>
              <audio controls :src="getOriginalAudioUrl(item.VoiceJp, activeStory!.path)" v-if="item.VoiceJp" preload="none" style="height: 32px;"></audio>
            </div>

            <div class="edit-box">
              <strong>TTS Text (TextJpVoice):</strong>
              <textarea v-model="item.TextJpVoice"></textarea>
            </div>

            <div class="actions">
              <button @click="generateTts(item, item._originalIndex)" :disabled="item._generating">
                {{ item._generating ? 'Generating...' : 'Test TTS' }}
              </button>

              <div v-if="item._tempAudioUrl" style="margin-top: 10px;">
                <strong>Temp Audio:</strong><br/>
                <audio controls :src="item._tempAudioUrl"></audio>
                <div style="margin-top: 5px; font-size: 12px; color: #6b7280;">
                  Preview only. Saving persists TextJpVoice but does not change VoiceJp or publish this audio.
                </div>
              </div>
              <div v-if="item._error" style="color: red; margin-top: 5px;">
                {{ item._error }}
              </div>
            </div>
          </div>
        </div>
        <div v-else>
          Select a story to edit.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import axios from 'axios';
import TreeItem from './components/TreeItem.vue';

interface StoryInfo {
  type: string;
  id: string;
  path: string;
  parent: string;
}

interface TreeFolder {
  name: string;
  type: 'folder';
  children: TreeNode[];
  isOpen: boolean;
}

type TreeNode = TreeFolder | StoryInfo;

const stories = ref<StoryInfo[]>([]);
const storyTree = ref<TreeFolder[]>([]);
const loadingStories = ref(false);
const activeStory = ref<StoryInfo | null>(null);
const activeStoryData = ref<any[] | null>(null);
const loadingStory = ref(false);
const saving = ref(false);

const ttsUrl = ref(localStorage.getItem('ttsUrl') || 'https://yiling.top/api/tts');
const ttsKey = ref(localStorage.getItem('ttsKey') || '');
const openAiTtsUrl = ref(localStorage.getItem('openAiTtsUrl') || 'https://tts.api.c.yiling.top/v1');
const openAiTtsKey = ref(localStorage.getItem('openAiTtsKey') || '');

onMounted(async () => {
  loadingStories.value = true;
  try {
    const res = await axios.get('/api/stories');
    stories.value = res.data;
    storyTree.value = buildTree(res.data);
  } catch (err) {
    console.error(err);
  } finally {
    loadingStories.value = false;
  }
});

function buildTree(list: StoryInfo[]): TreeFolder[] {
  const root: TreeFolder[] = [];

  for (const item of list) {
    // path could be "event/10014/10014005.json"
    const parts = item.path.replace('.json', '').split('/');
    // e.g. ["event", "10014", "10014005"]

    let currentLevel: TreeNode[] = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        // Last part is the file itself
        currentLevel.push(item);
      } else {
        // It's a folder
        let folder = currentLevel.find(
          (node): node is TreeFolder => 'children' in node && node.name === part
        );
        if (!folder) {
          folder = { name: part, type: 'folder', children: [], isOpen: false };
          currentLevel.push(folder);
        }
        currentLevel = folder.children;
      }
    }
  }
  return root;
}

const dialogItems = computed(() => {
  if (!activeStoryData.value) return [];
  return activeStoryData.value.filter(item => item.TextCn || item.TextJp || item.TextJpVoice);
});

async function loadStory(story: StoryInfo) {
  activeStory.value = story;
  loadingStory.value = true;
  activeStoryData.value = null;
  try {
    const res = await axios.get(`/api/story?path=${encodeURIComponent(story.path)}`);

    // Check if it's nested under .content (viewer JSON format)
    const rawData = Array.isArray(res.data.data) ? res.data.data : (res.data.data.content || []);

    activeStoryData.value = rawData.map((item: any, index: number) => ({
      ...item,
      _originalIndex: index,
      _generating: false,
      _tempAudioUrl: null,
      _error: null
    }));
  } catch (err) {
    console.error(err);
  } finally {
    loadingStory.value = false;
  }
}

function getOriginalAudioUrl(voiceJpUrl: string, path: string) {
  if (!voiceJpUrl) return '';
  if (voiceJpUrl.startsWith('http')) {
    const parts = voiceJpUrl.split('/');
    const filename = parts[parts.length - 1];

    // Path looks like "event/10014/10014005.json" or "group/1103/1103.json"
    // We want to serve from "/audio/tts/<type>/.../lines/<filename>"
    // .local-files/tts structure is usually .local-files/tts/event/10014005/lines/0004.mp3
    const id = path.split('/').pop()?.replace('.json', '');
    const type = path.split('/')[0];

    return `/audio/tts/${type}/${id}/lines/${filename}`;
  }
  return voiceJpUrl;
}

function extractCharacterName(item: any): string {
  if (item.NameCN) return item.NameCN;
  if (item.CharacterName) return item.CharacterName;
  if (item.SpeakerName) return item.SpeakerName;

  if (item.ScriptKr) {
    const parts = item.ScriptKr.split(';');
    if (parts.length >= 3) {
      // Clean up the name string since it might have metadata attached
      return parts[1].trim();
    }
  }
  return '';
}

async function generateTts(item: any, index: number) {
  localStorage.setItem('ttsUrl', ttsUrl.value);
  localStorage.setItem('ttsKey', ttsKey.value);
  localStorage.setItem('openAiTtsUrl', openAiTtsUrl.value);
  localStorage.setItem('openAiTtsKey', openAiTtsKey.value);

  item._generating = true;
  item._error = null;
  item._tempAudioUrl = null;

  try {
    const res = await axios.post('/api/tts/generate', {
      text: item.TextJpVoice,
      character: extractCharacterName(item),
      storyType: activeStory.value!.type,
      storyId: activeStory.value!.id,
      index,
      ttsUrl: ttsUrl.value,
      ttsKey: ttsKey.value,
      openAiTtsUrl: openAiTtsUrl.value,
      openAiTtsKey: openAiTtsKey.value
    });

    if (res.data.success) {
      item._tempAudioUrl = res.data.tempUrl;
    } else {
      item._error = res.data.error || res.data.message;
    }
  } catch (err: any) {
    item._error = err.response?.data?.error || (err as Error).message;
  } finally {
    item._generating = false;
  }
}

async function saveStory() {
  if (!activeStory.value || !activeStoryData.value) return;
  saving.value = true;

  const cleanData = activeStoryData.value.map(item => {
    const { _originalIndex, _generating, _tempAudioUrl, _error, ...rest } = item;
    return rest;
  });

  try {
    const res = await axios.get(`/api/story?path=${encodeURIComponent(activeStory.value.path)}`);
    let payload = cleanData;

    if (res.data.data && !Array.isArray(res.data.data)) {
      payload = {
        ...res.data.data,
        content: cleanData
      };
    }

    await axios.post(`/api/story?path=${encodeURIComponent(activeStory.value.path)}`, {
      data: payload
    });
    alert('Saved successfully!');
  } catch (err: any) {
    alert('Failed to save: ' + err.message);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.primary-btn {
  background: #3b82f6;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
}
.primary-btn:hover {
  background: #2563eb;
}
.primary-btn:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}
</style>
