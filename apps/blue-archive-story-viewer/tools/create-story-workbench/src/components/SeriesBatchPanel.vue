<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="series-dialog">
      <div class="stage-heading">
        <div><p class="eyebrow">SERIES BATCH</p><h2>活动系列批处理</h2></div>
        <button class="ghost" @click="emit('close')">关闭</button>
      </div>
      <p class="stage-description">按剧情顺序完成共享准备，并分别生成简中候选、扫描说话人、生成配音稿。每章停在自己的整体审查节点，不会因为前一章尚未审核而阻塞其他章节。</p>

      <form class="series-search" @submit.prevent="resolveSeries">
        <label>活动 ID、任一 GroupId 或活动名称
          <input v-model.trim="query" placeholder="例如 803 或 10002005" required />
        </label>
        <button class="primary" :disabled="loading">{{ loading ? '正在读取…' : '获取完整系列' }}</button>
      </form>

      <div v-if="error" class="notice error"><b>操作失败</b><span>{{ error }}</span><button @click="error=''">×</button></div>

      <template v-if="series">
        <div class="series-summary">
          <div><small>活动 {{ series.id }}</small><h3>{{ text(series.title) }}</h3></div>
          <b>{{ series.chapters.length }} 章</b>
        </div>
        <div class="batch-selection">
          <label><input v-model="selectionMode" type="radio" value="first" /> 前
            <input v-model.number="firstCount" class="count-input" type="number" min="1" :max="series.chapters.length" /> 章
          </label>
          <label><input v-model="selectionMode" type="radio" value="all" /> 全部章节</label>
          <span>将处理 {{ selectedChapters.length }} 章</span>
          <button class="primary" :disabled="!selectedChapters.length || running" @click="startBatch">一键推进到人工审核</button>
        </div>
        <label class="batch-model-config">LLM 模型名
          <input v-model.trim="llmModel" placeholder="gemini-3.7-flash" @change="rememberLlmModel" />
          <small>同一模型分别用于两轮中文校对和日语情绪稿；两条产物线仍独立保存。</small>
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
          <div><h3>批次进度</h3><small>第 {{ currentBatch.runCount }} 次推进 · {{ batchStatus(currentBatch.status) }}</small></div>
          <button class="primary" :disabled="running" @click="resumeBatch">再次推进到下一人工节点</button>
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

const props = defineProps({ initialQuery: { type: String, default: "" } });
const emit = defineEmits(["close", "open-workspace", "error"]);
const query = ref(props.initialQuery);
const series = ref(null);
const batches = ref([]);
const currentBatch = ref(null);
const loading = ref(false);
const error = ref("");
const selectionMode = ref("first");
const firstCount = ref(3);
const llmModel = ref(localStorage.getItem("story-workbench-llm-model") || "gemini-3.7-flash");
let pollTimer;

const selectedChapters = computed(() => {
  if (!series.value) return [];
  return selectionMode.value === "all"
    ? series.value.chapters
    : series.value.chapters.slice(0, Math.max(1, Math.min(firstCount.value || 1, series.value.chapters.length)));
});
const selectedIds = computed(() => new Set(selectedChapters.value.map(chapter => chapter.storyId)));
const running = computed(() => currentBatch.value?.status === "running");

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || payload.error);
  return payload;
}
function text(value) { return value?.TextCn || value?.TextJp || value?.TextTw || value?.fallback || "（未命名）"; }
function batchStatus(value) { return ({ queued: "排队中", running: "执行中", waiting: "等待人工处理", failed: "部分失败", interrupted: "已中断" })[value] || value; }
function itemStatus(value) { return ({ queued: "排队中", running: "执行中", waiting: "等待人工处理", failed: "执行失败" })[value] || value; }
function humanGate(gate) { return gate === "production-human" || gate === "production-prerequisites-complete"; }

async function resolveSeries() {
  loading.value = true;
  error.value = "";
  try {
    const payload = await api(`/api/series/event?query=${encodeURIComponent(query.value)}`);
    series.value = payload.series;
    firstCount.value = Math.min(3, series.value.chapters.length);
  } catch (cause) { error.value = cause.message; }
  finally { loading.value = false; }
}
async function loadBatches() {
  try {
    const payload = await api("/api/batches");
    batches.value = payload.batches.filter(batch => Number(batch.schemaVersion) >= 2);
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
async function startBatch() {
  if (!window.confirm(`将串行处理 ${selectedChapters.value.length} 章，并调用两轮中文 LLM。每章会在下一个人工节点停止，确认继续？`)) return;
  try {
    const payload = await api("/api/batches", {
      method: "POST",
      body: JSON.stringify({
        query: series.value.id,
        storyIds: selectedChapters.value.map(item => item.storyId),
        params: { llm: { model: llmModel.value }, voiceDraft: { model: llmModel.value } },
        confirmed: true,
      }),
    });
    currentBatch.value = payload.batch;
    await loadBatches();
  } catch (cause) { error.value = cause.message; }
}
function rememberLlmModel() {
  if (!llmModel.value) llmModel.value = "gemini-3.7-flash";
  localStorage.setItem("story-workbench-llm-model", llmModel.value);
}
async function resumeBatch() {
  if (!window.confirm("将重新检测每章的两条独立线路，并继续执行尚未完成的自动任务；每章仍会停在自己的人工节点。确认继续？")) return;
  try {
    currentBatch.value = (await api(`/api/batches/${encodeURIComponent(currentBatch.value.id)}/resume`, {
      method: "POST", body: JSON.stringify({ confirmed: true }),
    })).batch;
  } catch (cause) { error.value = cause.message; }
}
function openItem(item) {
  emit("open-workspace", {
    id: `event:${item.directoryId}:${item.storyId}`,
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
