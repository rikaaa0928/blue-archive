<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="series-dialog">
      <div class="stage-heading">
        <div><p class="eyebrow">SERIES BATCH</p><h2>{{ isMain ? '主线批处理' : '活动系列批处理' }}</h2></div>
        <button class="ghost" @click="emit('close')">关闭</button>
      </div>
      <p class="stage-description">按剧情顺序完成共享准备。默认一键采用 LLM 结果、把待确认身份设为 NPC、保留已有默认分支并只为未选择页面补第一个选项，一直执行到录制与完整性验收结束；也可以只推进到人工审核。</p>

      <form class="series-search" @submit.prevent="resolveSeries">
        <label>{{ isMain ? 'all 或 StoryId 数字前缀' : '活动 ID、任一 GroupId 或活动名称' }}
          <input v-model.trim="query" :placeholder="isMain ? '例如 all、31 或 31010' : '例如 803 或 10002005'" required />
        </label>
        <button class="primary" :disabled="loading">{{ loading ? '正在读取…' : '获取完整系列' }}</button>
      </form>

      <div v-if="error" class="notice error"><b>操作失败</b><span>{{ error }}</span><button @click="error=''">×</button></div>

      <template v-if="series">
        <div class="series-summary">
          <div><small>{{ isMain ? '主线范围' : '活动' }} {{ series.id }}</small><h3>{{ text(series.title) }}</h3></div>
          <b>{{ series.chapters.length }} 章</b>
        </div>
        <div class="batch-selection">
          <label><input v-model="selectionMode" type="radio" value="first" /> 前
            <input v-model.number="firstCount" class="count-input" type="number" min="1" :max="series.chapters.length" /> 章
          </label>
          <label><input v-model="selectionMode" type="radio" value="all" /> 全部章节</label>
          <span>将处理 {{ selectedChapters.length }} 章</span>
          <button class="primary" :disabled="!selectedChapters.length || running" @click="startBatch('complete')">一键完成（默认选择）</button>
          <button class="ghost" :disabled="!selectedChapters.length || running" @click="startBatch('review')">一键推进到人工审核</button>
        </div>
        <label class="batch-model-config">简中字幕模型
          <input v-model.trim="cnModel" placeholder="gemini-3.1-pro-preview" @change="rememberModels" />
          <small>用于两轮简中字幕校对。</small>
        </label>
        <label class="batch-model-config">语音情感模型
          <input v-model.trim="voiceModel" placeholder="gemini-3.7-flash" @change="rememberModels" />
          <small>用于日语配音稿的情感标注。</small>
        </label>
        <div class="series-chapters">
          <div
            v-for="chapter in series.chapters"
            :key="chapter.storyId"
            :class="['series-chapter', { selected: selectedIds.has(chapter.storyId) }]"
          >
            <b>{{ String(chapter.order).padStart(2, '0') }}</b>
            <div><strong>{{ text(chapter.title) }}</strong><small>{{ chapter.storyId }}</small></div>
            <span :class="['badge', chapter.progress.code]">{{ chapter.progress.label }}</span>
          </div>
        </div>
      </template>

      <section v-if="currentBatch" class="batch-progress">
        <div class="section-title">
          <div><h3>批次进度</h3><small>第 {{ currentBatch.runCount }} 次推进 · {{ batchMode(currentBatch.mode) }} · {{ batchStatus(currentBatch.status) }}</small></div>
          <div class="batch-resume-actions">
            <button class="primary" :disabled="running" @click="resumeBatch('complete')">继续完成到录制结束</button>
            <button class="ghost" :disabled="running" @click="resumeBatch('review')">再次推进到下一人工节点</button>
          </div>
        </div>
        <div class="batch-items">
          <article v-for="item in currentBatch.items" :key="item.storyId">
            <b>{{ String(item.order).padStart(2, '0') }}</b>
            <div><strong>{{ text(item.title) }}</strong><small>{{ item.storyId }}<template v-if="item.lastAction"> · 最近执行 {{ item.lastAction }}</template></small></div>
            <span :class="['batch-item-state', item.status]">{{ item.error || item.gateLabel || itemStatus(item.status) }}</span>
            <button v-if="humanGate(item.gate)" class="ghost small" @click="openItem(item)">打开处理</button>
          </article>
        </div>
        <details v-if="currentBatch.log"><summary>批处理日志</summary><pre>{{ currentBatch.log }}</pre></details>
      </section>

      <div v-if="batches.length" class="previous-batches">
        <b>最近批次</b>
        <button v-for="batch in batches.slice(0, 5)" :key="batch.id" @click="currentBatch = batch">
          <span>{{ text(batch.series.title) }}</span><small>{{ batch.items.length }} 章 · {{ batchStatus(batch.status) }}</small>
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps({
  initialQuery: { type: String, default: "" },
  seriesType: { type: String, default: "event" },
});
const emit = defineEmits(["close", "open-workspace", "error"]);
const query = ref(props.initialQuery);
const series = ref(null);
const batches = ref([]);
const currentBatch = ref(null);
const loading = ref(false);
const error = ref("");
const selectionMode = ref("first");
const firstCount = ref(3);
const cnModel = ref(localStorage.getItem("story-workbench-cn-llm-model") || "gemini-3.1-pro-preview");
const voiceModel = ref(localStorage.getItem("story-workbench-voice-script-llm-model") ||
  localStorage.getItem("story-workbench-llm-model") || "gemini-3.7-flash");
let pollTimer;

const selectedChapters = computed(() => {
  if (!series.value) return [];
  return selectionMode.value === "all"
    ? series.value.chapters
    : series.value.chapters.slice(0, Math.max(1, Math.min(firstCount.value || 1, series.value.chapters.length)));
});
const selectedIds = computed(() => new Set(selectedChapters.value.map(chapter => chapter.storyId)));
const running = computed(() => currentBatch.value?.status === "running");
const isMain = computed(() => props.seriesType === "main");

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || payload.error);
  return payload;
}
function text(value) { return value?.TextCn || value?.TextJp || value?.TextTw || value?.fallback || "（未命名）"; }
function batchStatus(value) { return ({ queued: "排队中", running: "执行中", waiting: "等待人工处理", completed: "已完成", failed: "部分失败", interrupted: "已中断" })[value] || value; }
function itemStatus(value) { return ({ queued: "排队中", running: "执行中", waiting: "等待人工处理", completed: "录制完成", failed: "执行失败" })[value] || value; }
function batchMode(value) { return value === "complete" ? "一键完成" : "推进到人工审核"; }
function humanGate(gate) { return gate === "production-human" || gate === "production-prerequisites-complete"; }

async function resolveSeries() {
  loading.value = true;
  error.value = "";
  try {
    const payload = await api(`/api/series/${encodeURIComponent(props.seriesType)}?query=${encodeURIComponent(query.value)}`);
    series.value = payload.series;
    firstCount.value = Math.min(3, series.value.chapters.length);
  } catch (cause) { error.value = cause.message; }
  finally { loading.value = false; }
}
async function loadBatches() {
  try {
    const payload = await api("/api/batches");
    batches.value = payload.batches.filter(batch =>
      Number(batch.schemaVersion) >= 2 && batch.series?.type === props.seriesType);
    if (!currentBatch.value && batches.value.length) currentBatch.value = batches.value[0];
  } catch (cause) { error.value = cause.message; }
}
async function refreshBatch() {
  if (!currentBatch.value) return;
  try {
    currentBatch.value = (await api(`/api/batches/${encodeURIComponent(currentBatch.value.id)}`)).batch;
    await loadBatches();
  } catch (cause) { error.value = cause.message; }
}
async function startBatch(mode) {
  const prompt = mode === "complete"
    ? `将串行完成 ${selectedChapters.value.length} 章，自动采用 LLM 结果、将待确认身份设为 NPC、保留已有默认分支并为未选择页面补第一个选项，同时调用 TTS、R2 和录制。确认继续？`
    : `将串行处理 ${selectedChapters.value.length} 章，并调用远端 LLM。每章会在下一个人工节点停止，确认继续？`;
  if (!window.confirm(prompt)) return;
  try {
    const payload = await api("/api/batches", {
      method: "POST",
      body: JSON.stringify({
        query: series.value.id,
        seriesType: props.seriesType,
        mode,
        storyIds: selectedChapters.value.map(item => item.storyId),
        params: { llm: { model: cnModel.value }, voiceDraft: { model: voiceModel.value } },
        confirmed: true,
      }),
    });
    currentBatch.value = payload.batch;
    await loadBatches();
  } catch (cause) { error.value = cause.message; }
}
function rememberModels() {
  if (!cnModel.value) cnModel.value = "gemini-3.1-pro-preview";
  if (!voiceModel.value) voiceModel.value = "gemini-3.7-flash";
  localStorage.setItem("story-workbench-cn-llm-model", cnModel.value);
  localStorage.setItem("story-workbench-voice-script-llm-model", voiceModel.value);
}
async function resumeBatch(mode) {
  const prompt = mode === "complete"
    ? "将从每章当前进度继续，自动接受待审核结果并执行参考音、TTS、默认分支和录制。确认继续？"
    : "将重新检测每章的两条独立线路，并继续执行尚未完成的自动任务；每章仍会停在自己的人工节点。确认继续？";
  if (!window.confirm(prompt)) return;
  try {
    currentBatch.value = (await api(`/api/batches/${encodeURIComponent(currentBatch.value.id)}/resume`, {
      method: "POST", body: JSON.stringify({ confirmed: true, mode }),
    })).batch;
  } catch (cause) { error.value = cause.message; }
}
function openItem(item) {
  emit("open-workspace", {
    id: currentBatch.value.series.type === "main"
      ? `main:_:${item.storyId}`
      : `event:${item.directoryId}:${item.storyId}`,
    stage: "production-overview",
  });
}

onMounted(async () => {
  await loadBatches();
  if (query.value) await resolveSeries();
  pollTimer = window.setInterval(() => { if (running.value) refreshBatch(); }, 1500);
});
onBeforeUnmount(() => window.clearInterval(pollTimer));
</script>
