<template>
  <section class="cover-studio">
    <section class="stage-card cover-studio-hero">
      <div class="stage-heading">
        <div><p class="eyebrow">SERIES COVER STUDIO</p><h2>系列封面工作室</h2></div>
        <span class="badge ready">独立工具</span>
      </div>
      <p class="stage-description">
        Gemini 会先通读所选章节的日文原文，统一规划整组封面的情绪节奏，再按顺序逐章生成。
        日文剧情会直接从原始表导出，不依赖字幕、语音、录制或工作区进度；生成结果仍需人工选择。
      </p>
      <form class="series-search cover-series-search" @submit.prevent="resolveSeries">
        <label>剧情类型
          <select v-model="seriesType"><option value="event">活动</option><option value="main">主线</option></select>
        </label>
        <label>{{ seriesType === 'event' ? '活动 ID、任一 GroupId 或活动名称' : '主线 StoryId 前缀' }}
          <input v-model.trim="query" :placeholder="seriesType === 'event' ? '例如 803 或 10002005' : '例如 31；留空表示全部主线'" :required="seriesType === 'event'" />
        </label>
        <button class="primary" :disabled="loading">{{ loading ? '读取系列中…' : '获取系列全部章节' }}</button>
      </form>
    </section>

    <div v-if="error" class="notice error"><b>操作失败</b><span>{{ error }}</span><button @click="error=''">×</button></div>

    <template v-if="series">
      <section class="stage-card">
        <div class="series-summary">
          <div><small>{{ series.type === 'main' ? '主线' : '活动' }} {{ series.id }}</small><h3>{{ titleText(series.title) }}</h3></div>
          <b>{{ readyChapters.length }}/{{ series.chapters.length }} 章可生成</b>
        </div>
        <section v-if="series.characters?.length" class="cover-character-versions">
          <div><b>角色参考图版本</b><small>每个角色可改用泳装、礼服等版本；未在本地准备的版本会在生成前只下载封面所需图片。</small></div>
          <label v-for="character in series.characters" :key="character.characterName">
            <span>{{ character.characterName }}</span>
            <select v-model="form.characterVersions[character.characterName]">
              <option v-for="option in character.options" :key="option.id" :value="option.resourceName">
                {{ option.label }}{{ option.recommended ? '（剧情推荐）' : '' }}{{ option.installed ? ' · 已就绪' : ' · 待准备' }}
              </option>
            </select>
          </label>
        </section>
        <p v-else class="muted cover-character-empty">当前系列尚无已整理的说话人表，生成时仍会从剧情解析基础角色；如需服装版本选择，请先完成相应章节的说话人整理。</p>
        <div class="cover-series-toolbar">
          <label class="wide">整组创作指导<textarea v-model.trim="form.guidance" rows="2" placeholder="可选：整组封面想强调的基调；逐章方向仍由系列规划器轮换" /></label>
          <label>分辨率<select v-model="form.resolution"><option>1K</option><option>2K</option><option>4K</option></select></label>
          <label>每章最多尝试<select v-model.number="form.maxAttempts"><option :value="1">1 次</option><option :value="2">2 次</option><option :value="3">3 次</option><option :value="4">4 次</option></select></label>
          <label class="cover-check"><input v-model="form.includeLobby" type="checkbox" /> 补充回忆大厅参考图</label>
        </div>
        <details class="history-box cover-models">
          <summary>模型设置</summary>
          <div>
            <label>系列规划与单章分析<input v-model.trim="form.analysisModel" /></label>
            <label>图片生成<input v-model.trim="form.imageModel" /></label>
            <label>视觉复检<input v-model.trim="form.qaModel" /></label>
          </div>
        </details>
        <div class="cover-selection-actions">
          <span>已选择 {{ selectedIds.size }} 章</span>
          <button class="ghost small" @click="selectAllReady">选择全部可生成章节</button>
          <button class="ghost small" @click="clearSelection">清空</button>
          <button class="primary" :disabled="!selectedIds.size || running" @click="startBatch">
            {{ running ? '系列封面生成中…' : `生成所选 ${selectedIds.size} 章封面` }}
          </button>
        </div>
      </section>

      <section class="cover-series-grid">
        <article v-for="chapter in series.chapters" :key="chapter.storyId" :class="['cover-series-card', { unavailable: !chapter.coverReady }]">
          <header>
            <label><input type="checkbox" :checked="selectedIds.has(chapter.storyId)" :disabled="!chapter.coverReady || running" @change="toggleChapter(chapter.storyId, $event.target.checked)" /></label>
            <b>{{ String(chapter.order).padStart(2, '0') }}</b>
            <div>
              <strong>{{ titleText(chapter.title) }}</strong>
              <small>{{ chapter.storyId }} · {{ chapter.coverReadyReason }}</small>
            </div>
            <span v-if="chapter.titleInherited" class="badge ready">续集 {{ chapter.continuationIndex }}</span>
          </header>
          <div class="chapter-title-reference">
            <span>日文标题</span><p lang="ja">{{ chapter.title.TextJp || '（沿用标题无日文版本）' }}</p>
          </div>
          <div v-if="chapter.candidates.length" class="series-cover-candidates">
            <article v-for="name in chapter.candidates" :key="name" :class="{ selected: name === chapter.selectedCover }">
              <img :src="coverUrl(chapter.storyId, name)" :alt="name" />
              <div class="candidate-actions">
                <button :class="name === chapter.selectedCover ? 'accept' : 'ghost'" @click="selectCover(chapter, name)">
                  {{ name === chapter.selectedCover ? '✓ 当前选择' : '选择此版本' }}
                </button>
                <button class="ghost" @click="revealCover(name)">Finder</button>
              </div>
              <small>{{ name }}</small>
            </article>
          </div>
          <p v-else class="muted">尚无封面候选</p>
          <button v-if="chapter.workspaceId" class="ghost small" @click="emit('open-workspace', { id: chapter.workspaceId, stage: 'production-final' })">返回该章制作页</button>
        </article>
      </section>
    </template>

    <section v-if="currentBatch" class="stage-card batch-progress">
      <div class="section-title">
        <div><h3>系列生成进度</h3><small>{{ batchStatus(currentBatch.status) }} · {{ currentBatch.items.length }} 章</small></div>
        <button class="ghost small" @click="refreshBatch">刷新</button>
      </div>
      <div class="batch-items">
        <article v-for="item in currentBatch.items" :key="item.storyId">
          <b>{{ String(item.order).padStart(2, '0') }}</b>
          <div>
            <strong>{{ titleText(item.title) }}</strong>
            <small>{{ item.storyId }}<template v-if="item.assignment"> · {{ directionLabel(item.assignment.coverDirection) }} · {{ item.assignment.chapterHook }}</template></small>
          </div>
          <span :class="['batch-item-state', item.status]">{{ item.error || itemLabel(item) }}</span>
        </article>
      </div>
      <details v-if="currentBatch.log" open><summary>实时日志</summary><pre>{{ currentBatch.log }}</pre></details>
    </section>

    <details v-if="batches.length" class="stage-card previous-cover-batches">
      <summary>历史系列封面任务（{{ batches.length }}）</summary>
      <button v-for="batch in batches.slice(0, 8)" :key="batch.id" @click="currentBatch = batch">
        <span>{{ titleText(batch.series.title) }}</span><small>{{ batch.items.length }} 章 · {{ batchStatus(batch.status) }}</small>
      </button>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

const props = defineProps({ initialQuery: { type: String, default: "" } });
const emit = defineEmits(["open-workspace", "error"]);
const query = ref(props.initialQuery);
const seriesType = ref("event");
const series = ref(null);
const batches = ref([]);
const currentBatch = ref(null);
const selectedIds = ref(new Set());
const loading = ref(false);
const error = ref("");
let pollTimer;

const storedImageModel = localStorage.getItem("story-workbench-cover-image-model");
const form = reactive({
  guidance: "",
  resolution: localStorage.getItem("story-workbench-cover-resolution") || "2K",
  maxAttempts: Number(localStorage.getItem("story-workbench-cover-attempts") || 2),
  includeLobby: false,
  characterVersions: {},
  analysisModel: localStorage.getItem("story-workbench-cover-analysis-model") || "gemini-3.7-flash",
  imageModel: storedImageModel === "gemini-3.1-flash-image-preview" ? "gemini-3.1-flash-image" : storedImageModel || "gemini-3.1-flash-image",
  qaModel: localStorage.getItem("story-workbench-cover-qa-model") || "gemini-3.7-flash",
});
const readyChapters = computed(() => series.value?.chapters.filter(chapter => chapter.coverReady) || []);
const running = computed(() => currentBatch.value?.status === "running");

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || payload.error);
  return payload;
}
function titleText(title) { return title?.TextCn || title?.TextJp || title?.TextTw || title?.TextKr || title?.TextEn || title?.fallback || "（未命名）"; }
function coverUrl(storyId, name) { return `/api/covers/${encodeURIComponent(storyId)}/${encodeURIComponent(name)}`; }
function directionLabel(value) { return ({ dramatic: "夸张剧情", lyrical: "抒情", "easter-egg": "彩蛋", symbolic: "象征" })[value] || value; }
function batchStatus(value) { return ({ queued: "排队中", running: "执行中", completed: "已完成", failed: "部分失败", interrupted: "已中断" })[value] || value; }
function itemLabel(item) { return ({ preparing: "正在导出日文剧情", queued: "等待处理", running: "正在生成", completed: item.qaPassed ? `完成 · QA ${item.qaScore}` : `完成 · 待人工检查 ${item.qaScore ?? ''}`, failed: "失败" })[item.status] || item.status; }
function toggleChapter(storyId, checked) { const next = new Set(selectedIds.value); if (checked) next.add(storyId); else next.delete(storyId); selectedIds.value = next; }
function selectAllReady() { selectedIds.value = new Set(readyChapters.value.map(chapter => chapter.storyId)); }
function clearSelection() { selectedIds.value = new Set(); }

async function resolveSeries() {
  loading.value = true; error.value = "";
  try {
    const effectiveQuery = seriesType.value === "main" ? query.value || "all" : query.value;
    series.value = (await api(`/api/cover-series/${seriesType.value}?query=${encodeURIComponent(effectiveQuery)}`)).series;
    form.characterVersions = Object.fromEntries((series.value.characters || [])
      .map(character => [character.characterName, character.selectedResourceName]));
    selectAllReady();
    const matchingBatch = batches.value.find(batch => String(batch.series?.id) === String(series.value.id));
    currentBatch.value = matchingBatch ?? null;
  } catch (cause) { error.value = cause.message; }
  finally { loading.value = false; }
}
async function loadBatches() {
  try {
    batches.value = (await api("/api/cover-batches")).batches;
    if (!currentBatch.value && batches.value.length) currentBatch.value = batches.value[0];
  } catch (cause) { error.value = cause.message; }
}
async function startBatch() {
  if (!window.confirm(`将按顺序为 ${selectedIds.value.size} 章调用 Gemini 系列规划、图片生成和视觉复检，可能产生较多费用。确认继续？`)) return;
  for (const [key, value] of Object.entries({
    "story-workbench-cover-resolution": form.resolution,
    "story-workbench-cover-attempts": String(form.maxAttempts),
    "story-workbench-cover-analysis-model": form.analysisModel,
    "story-workbench-cover-image-model": form.imageModel,
    "story-workbench-cover-qa-model": form.qaModel,
  })) localStorage.setItem(key, value);
  try {
    currentBatch.value = (await api("/api/cover-batches", {
      method: "POST",
      body: JSON.stringify({ type: series.value.type, query: series.value.id, storyIds: [...selectedIds.value], params: { ...form }, confirmed: true }),
    })).batch;
    await loadBatches();
  } catch (cause) { error.value = cause.message; }
}
async function refreshBatch() {
  if (!currentBatch.value) return;
  try {
    const previous = currentBatch.value.status;
    currentBatch.value = (await api(`/api/cover-batches/${encodeURIComponent(currentBatch.value.id)}`)).batch;
    if (previous === "running" && currentBatch.value.status !== "running" && series.value) await resolveSeries();
    await loadBatches();
  } catch (cause) { error.value = cause.message; }
}
async function selectCover(chapter, name) {
  try {
    await api(`/api/covers/${encodeURIComponent(chapter.storyId)}/select`, {
      method: "POST", body: JSON.stringify({ name }),
    });
    await resolveSeries();
  } catch (cause) { error.value = cause.message; }
}
async function revealCover(name) {
  try { await api("/api/covers/reveal", { method: "POST", body: JSON.stringify({ name }) }); }
  catch (cause) { error.value = cause.message; }
}

watch(() => props.initialQuery, async value => { if (!value || value === query.value) return; query.value = value; await resolveSeries(); });
onMounted(async () => {
  await loadBatches();
  if (query.value) await resolveSeries();
  pollTimer = window.setInterval(() => { if (running.value) refreshBatch(); }, 1500);
});
onBeforeUnmount(() => window.clearInterval(pollTimer));
</script>
