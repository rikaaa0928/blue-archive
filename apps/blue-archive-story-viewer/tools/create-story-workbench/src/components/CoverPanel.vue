<template>
  <section class="stage-card">
    <div class="stage-heading">
      <div><p class="eyebrow">OPTIONAL ASSET</p><h2>剧情封面管理</h2></div>
      <div class="cover-panel-actions">
        <button class="primary" @click="emit('open-cover-studio')">前往系列封面工作室</button>
        <label class="ghost upload-button">导入候选图<input type="file" accept="image/jpeg,image/png,image/webp" @change="upload" /></label>
      </div>
    </div>
    <p class="stage-description">
      图片生成已经移到独立的系列封面工作室，由 Gemini 通读整个活动并轮换创作方向。这里仅负责查看、导入和选择当前章节候选，不会自动发布。
    </p>
    <div class="cover-generator">
      <article v-if="latestRun" :class="['cover-run-summary', latestRun.qaPassed ? 'passed' : 'review']">
        <header>
          <div><b>最近一次 Gemini 制作</b><small>{{ latestRun.runId }} · {{ statusLabel(latestRun.status) }}</small></div>
          <strong v-if="latestRun.attempts?.length">{{ bestAttempt?.qa?.score ?? '–' }}/100</strong>
        </header>
        <p v-if="latestRun.plan"><b>{{ directionLabel(latestRun.plan.coverDirection) }}</b> · {{ latestRun.plan.sceneConcept }}</p>
        <p v-if="bestAttempt?.qa?.summary">复检：{{ bestAttempt.qa.summary }}</p>
        <ul v-if="bestAttempt?.qa?.issues?.length">
          <li v-for="(issue, index) in bestAttempt.qa.issues" :key="index">{{ issue.severity }} · {{ issue.description }}</li>
        </ul>
        <small>Gemini 复检用于筛掉明显问题，最终仍需人工确认角色身份、人数、手部、透视、意外文字和安全裁切。</small>
      </article>
    </div>

    <div class="cover-grid">
      <article v-for="file in files" :key="file.name" :class="['cover-card', { selected: file.selected }]">
        <img :src="file.url" :alt="file.name" />
        <div><b>{{ file.name }}</b><small>{{ Math.round(file.size / 1024) }} KiB</small></div>
        <footer class="candidate-actions">
          <button :class="file.selected ? 'accept' : 'ghost'" @click="selectCover(file)">{{ file.selected ? '✓ 当前选择' : '选择此版本' }}</button>
          <button class="ghost" @click="revealCover(file)">在 Finder 中显示</button>
        </footer>
      </article>
      <div v-if="!files.length" class="empty-list">还没有这篇剧情的封面候选图。</div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

const props = defineProps({
  workspaceId: { type: String, required: true },
});
const emit = defineEmits(["open-cover-studio", "error"]);
const files = ref([]);
const latestRun = ref(null);

const bestAttempt = computed(() => {
  const attempts = latestRun.value?.attempts || [];
  return attempts.find(item => item.number === latestRun.value?.bestAttempt) ||
    [...attempts].sort((left, right) => Number(right.qa?.score || 0) - Number(left.qa?.score || 0))[0];
});

function url(suffix = "") { return `/api/workspaces/${encodeURIComponent(props.workspaceId)}/covers${suffix}`; }
async function load() {
  try {
    const response = await fetch(url()); const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || payload.error);
    files.value = payload.files;
    latestRun.value = payload.latestRun;
  } catch (error) { emit("error", error); }
}
async function upload(event) {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    const response = await fetch(url(), { method: "POST", headers: { "X-File-Name": encodeURIComponent(file.name) }, body: file });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.message || payload.error); await load();
  } catch (error) { emit("error", error); } finally { event.target.value = ""; }
}
async function selectCover(file) {
  try {
    const response = await fetch(url("/select"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name }) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.message || payload.error); await load();
  } catch (error) { emit("error", error); }
}
async function revealCover(file) {
  try {
    const response = await fetch("/api/covers/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name }) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.message || payload.error);
  } catch (error) { emit("error", error); }
}
function statusLabel(status) { return ({ completed: "自动复检通过", "needs-human-review": "未达到自动复检阈值，保留候选供人工查看", generating: "生成中", planning: "分析中", failed: "失败" })[status] || status; }
function directionLabel(value) { return ({ dramatic: "夸张剧情封面", lyrical: "抒情封面", "easter-egg": "彩蛋封面", symbolic: "象征性封面" })[value] || value; }
watch(() => props.workspaceId, load);
onMounted(load);
</script>
