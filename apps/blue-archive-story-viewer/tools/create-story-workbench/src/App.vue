<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">BA</span>
        <div><strong>剧情制作工作台</strong><small>Story Production</small></div>
      </div>

      <nav class="tool-switcher">
        <button :class="{ active: toolMode === 'production' }" @click="switchTool('production')">剧情制作</button>
        <button :class="{ active: toolMode === 'covers' }" @click="switchTool('covers')">系列封面</button>
      </nav>

      <template v-if="toolMode === 'production'">
      <label class="workspace-picker">
        <span>当前工作区</span>
        <select v-model="selectedId" @change="selectWorkspace">
          <option value="">请选择</option>
          <option v-for="item in workspaces" :key="item.id" :value="item.id">
            {{ workspaceLabel(item) }}
          </option>
        </select>
      </label>
      <button class="series-entry full" @click="showSeriesBatch = true">▦ {{ batchSeriesType === 'main' ? '主线批处理' : '活动系列批处理' }}</button>
      <button class="ghost full" @click="showCreate = !showCreate">＋ 新建工作区</button>
      <form v-if="showCreate" class="create-form" @submit.prevent="createWorkspace">
        <select v-model="createForm.type">
          <option v-for="type in storyTypes" :key="type">{{ type }}</option>
        </select>
        <input v-model.trim="createForm.storyId" placeholder="GroupId / StoryId" required />
        <input v-if="nestedType" v-model.trim="createForm.directoryId" placeholder="目录 ID（可留空）" />
        <button class="primary">创建</button>
      </form>

      <nav v-if="status" class="stage-nav">
        <button
          v-for="(stage, index) in productionStages"
          :key="stage.id"
          :class="['stage-link', { active: selectedStage === stage.id }]"
          @click="selectedStage = stage.id"
        >
          <span class="stage-number">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="stage-copy"><b>{{ stage.title }}</b><small>{{ stage.detail }}</small></span>
          <i :class="['status-dot', stageStatus(stage.id)]" :title="stageStatus(stage.id)"></i>
        </button>
      </nav>
      </template>
      <div class="sidebar-foot">仅监听 127.0.0.1<br />大版本隔离，分支内保留增量记录</div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ toolMode === 'covers' ? 'SERIES COVER STUDIO' : activeStage?.kind || 'WORKSPACE' }}</p>
          <h1>{{ toolMode === 'covers' ? '系列封面工作室' : activeStage?.title || '从左侧创建或选择剧情工作区' }}</h1>
        </div>
        <div class="top-actions">
          <button
            v-if="notificationSupported"
            :class="['ghost', { 'notification-enabled': notificationsActive }]"
            :disabled="notificationPermission === 'denied'"
            @click="toggleNotifications"
          >
            {{ notificationButtonLabel }}
          </button>
          <button v-if="toolMode === 'production' && status" class="version-button" :disabled="busy" @click="showVersions = true">
            {{ activeVersion?.label || status.workspace.activeVersionId }} · 版本管理
          </button>
          <span v-if="toolMode === 'production' && status?.current" class="revision-pill">{{ status.current.revision }}</span>
          <button v-if="toolMode === 'production'" class="ghost" :disabled="busy" @click="refresh">↻ 重新检测</button>
        </div>
      </header>

      <section v-if="toolMode === 'production' && chapterContext" class="chapter-context-banner">
        <div><small>正在处理 · {{ titleText(chapterContext.series.title) }}</small><h2>{{ titleText(chapterContext.chapter.title) }}</h2></div>
        <span>第 {{ chapterContext.chapter.order }} 章 · {{ chapterContext.chapter.storyId }}</span>
        <b v-if="chapterContext.chapter.titleInherited">续集 {{ chapterContext.chapter.continuationIndex }}</b>
      </section>

      <div v-if="error" class="notice error"><b>操作失败</b><span>{{ error }}</span><button @click="error=''">×</button></div>
      <div v-if="message" class="notice success"><b>已完成</b><span>{{ message }}</span><button @click="message=''">×</button></div>

      <section v-if="runningTaskCount" class="task-monitor active">
        <div class="task-monitor-heading">
          <div><span class="task-spinner"></span><div><b>{{ runningTaskCount }} 个任务正在运行</b><small>每 1.5 秒刷新状态和日志</small></div></div>
          <span>{{ formatClock(clock) }}</span>
        </div>
        <article v-for="job in globalJobs" :key="`${job.workspaceId}-${job.id}`" class="task-monitor-row">
          <div class="task-copy"><strong>{{ actionLabel(job.action) }}</strong><small>{{ taskScope(job) }} · 已运行 {{ elapsed(job.startedAt) }}</small></div>
          <span class="badge running">运行中</span>
          <details><summary>实时日志</summary><pre>{{ job.log || '等待任务输出…' }}</pre></details>
        </article>
        <article v-for="batch in globalBatches" :key="batch.id" class="task-monitor-row">
          <div class="task-copy"><strong>{{ batchActionLabel(batch) }}</strong><small>{{ batch.items?.length || 0 }} 章 · 已运行 {{ elapsed(batch.startedAt) }}</small></div>
          <span class="badge running">运行中</span>
          <details><summary>批处理日志</summary><pre>{{ batch.log || '等待批处理输出…' }}</pre></details>
        </article>
      </section>
      <details v-else-if="status && jobs.length" class="task-monitor idle">
        <summary>当前没有运行任务 · 最近任务：{{ actionLabel(jobs[0].action) }}（{{ jobStatusLabel(jobs[0].status) }}）</summary>
        <article v-for="job in jobs.slice(0, 3)" :key="job.id" class="task-monitor-row">
          <div class="task-copy"><strong>{{ actionLabel(job.action) }}</strong><small>{{ formatTime(job.startedAt) }} · {{ finishedDuration(job) }}</small></div>
          <span :class="['badge', job.status]">{{ jobStatusLabel(job.status) }}</span>
          <details><summary>查看日志</summary><pre>{{ job.log || '没有日志输出' }}</pre></details>
        </article>
      </details>

      <SeriesCoverWorkbench
        v-if="toolMode === 'covers'"
        :initial-query="coverInitialQuery"
        @open-workspace="openCoverWorkspace"
        @error="handleError"
      />

      <section v-else-if="!status" class="empty-state">
        <div class="empty-icon">◫</div>
        <h2>一次制作，可以保留多条可信的版本分支</h2>
        <p>环境安装仍在终端完成；同步、导入、审核、语音、录制与本地成品都可以在这里继续。</p>
      </section>

      <template v-else>
        <section class="summary-grid">
          <article class="metric"><small>制作基线</small><strong>{{ productionSummary?.base ? status.workspace.activeVersionId : '尚未准备' }}</strong><span>{{ productionSummary?.base?.rows || 0 }} 行</span></article>
          <article class="metric"><small>本地原始表</small><strong>{{ status.tables.ready ? '已就绪' : '未就绪' }}</strong><span>{{ readyTableCount }}/6 可解析</span></article>
          <article class="metric"><small>说话人与参考音</small><strong>{{ productionSummary?.voice?.speakers?.ready && productionSummary?.voice?.references?.ready ? '已就绪' : '处理中' }}</strong><span>{{ productionSummary?.voice?.speakers?.unresolvedCount || 0 }} 个例外待确认</span></article>
          <article class="metric"><small>TTS</small><strong>{{ productionSummary?.voice?.tts?.completed || 0 }}/{{ productionSummary?.voice?.tts?.total || 0 }}</strong><span>当前版本生成数</span></article>
        </section>

        <ProductionWorkbench
          :workspace-id="selectedId"
          :section="selectedStage"
          :latest-job="latestJob"
          :busy="busy"
          :status="status"
          @run="runAction"
          @navigate="selectedStage = $event"
          @changed="refresh"
          @open-cover-studio="openCoverStudio"
          @error="handleError"
        />
      </template>
      <SeriesBatchPanel
        v-if="toolMode === 'production' && showSeriesBatch"
        :series-type="batchSeriesType"
        :initial-query="batchInitialQuery"
        @close="showSeriesBatch = false"
        @open-workspace="openBatchWorkspace"
      />
      <VersionManager
        v-if="showVersions && status"
        :workspace-id="selectedId"
        :status="status"
        :busy="busy"
        @close="showVersions = false"
        @changed="handleVersionChanged"
        @error="handleError"
      />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import SeriesBatchPanel from "./components/SeriesBatchPanel.vue";
import VersionManager from "./components/VersionManager.vue";
import ProductionWorkbench from "./components/ProductionWorkbench.vue";
import SeriesCoverWorkbench from "./components/SeriesCoverWorkbench.vue";

const storyTypes = ["event", "group", "main", "favor", "mini", "other"];
const workspaces = ref([]);
const selectedId = ref(localStorage.getItem("story-workbench-id") || "");
const storedToolMode = localStorage.getItem("story-workbench-tool");
const toolMode = ref(storedToolMode && ["production", "covers"].includes(storedToolMode) ? storedToolMode : "production");
const coverInitialQuery = ref("");
const chapterContext = ref(null);
const selectedStage = ref("production-overview");
const status = ref(null);
const jobs = ref([]);
const globalJobs = ref([]);
const globalBatches = ref([]);
const busy = ref(false);
const error = ref("");
const message = ref("");
const showCreate = ref(false);
const showSeriesBatch = ref(false);
const showVersions = ref(false);
const createForm = ref({ type: "event", storyId: "", directoryId: "" });
const productionSummary = ref(null);
const clock = ref(Date.now());
const notificationSupported = typeof window !== "undefined" && "Notification" in window;
const notificationPermission = ref(notificationSupported ? Notification.permission : "unsupported");
const notificationsEnabled = ref(localStorage.getItem("story-workbench-notifications") !== "disabled");
const notifiedTerminalTasks = new Set();
let pollTimer; let clockTimer; let polling = false;

const productionStages = [
  { id: "production-overview", title: "制作总览", kind: "WORKBENCH", detail: "两条独立产物线" },
  { id: "production-cn", title: "简中字幕", kind: "CN TRACK", detail: "整体审查与永久微调" },
  { id: "production-voice", title: "克隆语音", kind: "VOICE TRACK", detail: "说话人、参考音、配音稿与 TTS" },
  { id: "production-final", title: "最终预览", kind: "ASSEMBLY", detail: "结构、分支、正式文件与录制" },
];

const nestedType = computed(() => !["main", "other"].includes(createForm.value.type));
const batchSeriesType = computed(() => status.value?.workspace.identity.type === "main" ? "main" : "event");
const batchInitialQuery = computed(() => batchSeriesType.value === "main"
  ? String(status.value?.workspace.identity.storyId || "").slice(0, 2) || "all"
  : status.value?.workspace.identity.type === "event" ? status.value.workspace.identity.storyId : "");
const activeStage = computed(() => productionStages.find(item => item.id === selectedStage.value));
const readyTableCount = computed(() => status.value?.tables.files.filter(file => file.ready).length ?? 0);
const latestJob = computed(() => jobs.value[0]);
const activeVersion = computed(() => status.value?.workspace.versions.find(version => version.active));
const runningTaskCount = computed(() => globalJobs.value.length + globalBatches.value.length);
const notificationsActive = computed(() =>
  notificationSupported &&
  notificationPermission.value === "granted" &&
  notificationsEnabled.value
);
const notificationButtonLabel = computed(() => {
  if (notificationPermission.value === "denied") return "🔕 通知权限被禁用";
  if (notificationPermission.value !== "granted") return "🔔 开启任务通知";
  return notificationsEnabled.value ? "🔔 任务通知已开启" : "🔕 任务通知已关闭";
});

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    const failure = new Error(payload.message || payload.error || `HTTP ${response.status}`);
    failure.code = payload.error;
    throw failure;
  }
  return payload;
}

function workspaceUrl(suffix = "") {
  return `/api/workspaces/${encodeURIComponent(selectedId.value)}${suffix}`;
}

async function loadWorkspaces() {
  const payload = await api("/api/workspaces");
  workspaces.value = payload.workspaces.filter(item => !item.corrupt);
  if (selectedId.value && workspaces.value.some(item => item.id === selectedId.value)) await refresh();
  else await loadGlobalTasks();
}

async function createWorkspace() {
  try {
    const payload = await api("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(createForm.value),
    });
    selectedId.value = payload.workspace.id;
    localStorage.setItem("story-workbench-id", selectedId.value);
    status.value = payload.status;
    showCreate.value = false;
    await loadWorkspaces();
  } catch (cause) { handleError(cause); }
}

async function selectWorkspace() {
  toolMode.value = "production";
  localStorage.setItem("story-workbench-tool", toolMode.value);
  localStorage.setItem("story-workbench-id", selectedId.value);
  selectedStage.value = "production-overview";
  await refresh();
}

async function refresh() {
  if (!selectedId.value) { await loadGlobalTasks(); return; }
  try {
    const [nextStatus, jobPayload, productionPayload, taskPayload] = await Promise.all([
      api(workspaceUrl("/status")), api(workspaceUrl("/jobs")), api(workspaceUrl("/production")), api("/api/jobs/running"),
    ]);
    status.value = nextStatus;
    jobs.value = jobPayload.jobs;
    productionSummary.value = productionPayload.production;
    await notifyFinishedTasks(globalJobs.value, globalBatches.value, taskPayload);
    applyRunningTaskSnapshot(taskPayload);
    busy.value = jobs.value.some(job => job.status === "running");
    await loadChapterContext();
  } catch (cause) { handleError(cause); }
}

async function loadGlobalTasks() {
  const payload = await api("/api/jobs/running");
  await notifyFinishedTasks(globalJobs.value, globalBatches.value, payload);
  applyRunningTaskSnapshot(payload);
}

function applyRunningTaskSnapshot(payload) {
  globalJobs.value = payload.jobs;
  globalBatches.value = payload.batches;
}

async function toggleNotifications() {
  if (!notificationSupported || notificationPermission.value === "denied") return;
  if (notificationPermission.value !== "granted") {
    notificationPermission.value = await Notification.requestPermission();
    notificationsEnabled.value = notificationPermission.value === "granted";
  } else {
    notificationsEnabled.value = !notificationsEnabled.value;
  }
  localStorage.setItem(
    "story-workbench-notifications",
    notificationsEnabled.value ? "enabled" : "disabled"
  );
}

function showTaskNotification({ key, title, body, failed = false }) {
  if (notifiedTerminalTasks.has(key)) return;
  notifiedTerminalTasks.add(key);
  if (failed) error.value = body;
  else message.value = body;
  if (!notificationsActive.value) return;
  const notification = new Notification(title, {
    body,
    tag: `story-workbench-${key}`,
    requireInteraction: failed,
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

async function notifyFinishedTasks(previousJobs, previousBatches, nextPayload) {
  const runningJobKeys = new Set(
    nextPayload.jobs.map(job => `${job.workspaceId}/${job.id}`)
  );
  const runningBatchIds = new Set(nextPayload.batches.map(batch => batch.id));

  for (const previous of previousJobs) {
    const key = `${previous.workspaceId}/${previous.id}`;
    if (runningJobKeys.has(key) || notifiedTerminalTasks.has(`job-${key}`)) continue;
    try {
      const payload = await api(
        `/api/workspaces/${encodeURIComponent(previous.workspaceId)}/jobs/${encodeURIComponent(previous.id)}`
      );
      const job = payload.job;
      if (job.status === "running") continue;
      const failed = job.status !== "completed";
      const scope = taskScope(previous);
      showTaskNotification({
        key: `job-${key}`,
        title: failed ? "剧情制作任务失败" : "剧情制作任务完成",
        body: `${actionLabel(job.action)}（${scope}）${failed ? jobStatusLabel(job.status) : "已完成"}`,
        failed,
      });
    } catch (cause) {
      console.warn("Unable to resolve completed job", key, cause);
    }
  }

  for (const previous of previousBatches) {
    if (runningBatchIds.has(previous.id) || notifiedTerminalTasks.has(`batch-${previous.id}`)) continue;
    try {
      const endpoint = previous.kind === "event-series-covers" ? "cover-batches" : "batches";
      const batch = (await api(`/api/${endpoint}/${encodeURIComponent(previous.id)}`)).batch;
      if (batch.status === "running") continue;
      const failed = ["failed", "interrupted"].includes(batch.status);
      showTaskNotification({
        key: `batch-${previous.id}`,
        title: previous.kind === "event-series-covers"
          ? failed ? "系列封面生成失败" : "系列封面生成完成"
          : failed ? "活动批处理失败" : "活动批处理已停止在人工节点",
        body: `${batch.series?.title?.TextCn || batch.series?.title?.TextJp || batch.series?.id || "活动系列"}：${batchStatusLabel(batch.status)}`,
        failed,
      });
    } catch (cause) {
      console.warn("Unable to resolve completed batch", previous.id, cause);
    }
  }
}

async function pollTasks() {
  if (polling) return;
  polling = true;
  try {
    const taskPromise = api("/api/jobs/running");
    const jobPromise = selectedId.value ? api(workspaceUrl("/jobs")) : Promise.resolve({ jobs: [] });
    const [taskPayload, jobPayload] = await Promise.all([taskPromise, jobPromise]);
    const wasBusy = busy.value;
    const previousJobs = globalJobs.value;
    const previousBatches = globalBatches.value;
    await notifyFinishedTasks(previousJobs, previousBatches, taskPayload);
    applyRunningTaskSnapshot(taskPayload);
    jobs.value = jobPayload.jobs;
    busy.value = jobs.value.some(job => job.status === "running");
    if (wasBusy && !busy.value) await refresh();
  } catch (cause) { handleError(cause); }
  finally { polling = false; }
}

async function runAction(action, params = {}) {
  if (new Set(["event-index", "production-event-index"]).has(action) && !params.place) {
    const place = window.prompt("活动归属：shanhaijing / millennium / trinity");
    if (!place) return;
    params = { ...params, place };
  }
  const remote = [
    "production-cn-generate",
    "production-voice-script-generate",
    "production-reference-prepare",
    "production-tts",
    "production-record",
    "production-cover-generate",
    "production-event-index",
  ].includes(action);
  const confirmed = !remote || window.confirm(confirmText(action, params));
  if (!confirmed) return;
  try {
    await api(workspaceUrl("/jobs"), {
      method: "POST",
      body: JSON.stringify({ action, params, confirmed }),
    });
    busy.value = true;
    message.value = `已启动 ${action}，日志会持续保存在工作区。`;
    await refresh();
  } catch (cause) { handleError(cause); }
}

async function openBatchWorkspace({ id, stage }) {
  toolMode.value = "production";
  localStorage.setItem("story-workbench-tool", toolMode.value);
  selectedId.value = id;
  localStorage.setItem("story-workbench-id", id);
  showSeriesBatch.value = false;
  await loadWorkspaces();
  await refresh();
  selectedStage.value = stage;
}
async function openCoverWorkspace({ id, stage }) {
  selectedId.value = id;
  localStorage.setItem("story-workbench-id", id);
  toolMode.value = "production";
  localStorage.setItem("story-workbench-tool", toolMode.value);
  await loadWorkspaces();
  await refresh();
  selectedStage.value = stage || "production-final";
}
function openCoverStudio(query = "") {
  coverInitialQuery.value = String(query || status.value?.workspace.identity.storyId || "");
  switchTool("covers");
}
function switchTool(mode) {
  toolMode.value = mode;
  localStorage.setItem("story-workbench-tool", mode);
  if (mode === "covers" && !coverInitialQuery.value && status.value?.workspace.identity.type === "event") {
    coverInitialQuery.value = status.value.workspace.identity.storyId;
  }
  if (mode === "covers") loadGlobalTasks();
}
async function loadChapterContext() {
  chapterContext.value = null;
  const identity = status.value?.workspace.identity;
  if (identity?.type !== "event") return;
  try {
    const series = (await api(`/api/series/event?query=${encodeURIComponent(identity.storyId)}`)).series;
    const chapter = series.chapters.find(item => item.storyId === String(identity.storyId));
    if (chapter) chapterContext.value = { series, chapter };
  } catch (cause) { console.warn("Unable to load chapter title", cause); }
}
async function handleVersionChanged({ status: nextStatus, stage, created }) {
  status.value = nextStatus;
  showVersions.value = false;
  if (stage) selectedStage.value = stage;
  jobs.value = [];
  message.value = created
    ? `已创建 ${created.label}（${created.id}），从 ${stage} 重新推进。`
    : `已切换到 ${nextStatus.workspace.activeVersionId}。`;
  await loadWorkspaces();
  await refresh();
}
function handleError(cause) { error.value = cause?.message || String(cause); }
function workspaceLabel(item) { return `${item.identity?.type || ''} / ${item.identity?.storyId || item.id}`; }
function titleText(title) { return title?.TextCn || title?.TextJp || title?.TextTw || title?.TextKr || title?.TextEn || title?.fallback || "（未命名）"; }
function actionLabel(action) { return ({
  "production-prepare": "自动准备剧情基线",
  "production-cn-generate": "两轮简中 LLM 校对",
  "production-speaker-scan": "查询并识别说话人",
  "production-voice-script-generate": "生成日语配音稿",
  "production-reference-prepare": "拉取角色资源并准备参考音",
  "production-tts": "生成并上传克隆语音",
  "production-event-index": "更新活动剧情索引",
  "production-record": "生成并验收预览视频",
  "production-cover-generate": "Gemini 分析剧情并生成封面",
})[action] || action; }
function jobStatusLabel(status) { return ({ completed: "已完成", failed: "失败", interrupted: "已中断", running: "运行中", queued: "排队中" })[status] || status; }
function batchStatusLabel(status) { return ({ waiting: "自动步骤已完成，等待人工处理", failed: "执行失败", interrupted: "执行已中断", completed: "已完成" })[status] || status; }
function batchActionLabel(batch) { return batch.kind === "event-series-covers" ? "系列封面生成" : "活动系列批处理"; }
function taskScope(job) { const identity = job.workspaceIdentity || {}; return `${identity.type || 'story'} / ${identity.storyId || job.workspaceId}`; }
function elapsed(startedAt) { if (!startedAt) return "等待启动"; const seconds = Math.max(0, Math.floor((clock.value - Date.parse(startedAt)) / 1000)); return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`; }
function finishedDuration(job) { if (!job.startedAt) return "未启动"; const end = job.finishedAt ? Date.parse(job.finishedAt) : clock.value; const seconds = Math.max(0, Math.floor((end - Date.parse(job.startedAt)) / 1000)); return `耗时 ${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`; }
function formatTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : ""; }
function formatClock(value) { return new Date(value).toLocaleTimeString("zh-CN", { hour12: false }); }
function stageStatus(id) {
  if (!productionSummary.value) return id === "production-overview" ? "ready" : "locked";
  if (id === "production-overview") return "completed";
  if (id === "production-cn") return productionSummary.value.cn.ready ? "completed" : "ready";
  if (id === "production-voice") return productionSummary.value.voice.script.ready && productionSummary.value.voice.speakers.ready && productionSummary.value.voice.references.ready ? "completed" : "ready";
  if (id === "production-final") return productionSummary.value.preview.complete ? "completed" : "ready";
  return "ready";
}
function confirmText(action, params) { return `即将执行 ${action}${params.ttsStage ? ` (${params.ttsStage})` : ""}。该操作可能访问远端、产生费用或写入正式目录。确认继续？`; }

onMounted(async () => {
  await loadWorkspaces();
  pollTimer = window.setInterval(pollTasks, 1500);
  clockTimer = window.setInterval(() => { clock.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => { window.clearInterval(pollTimer); window.clearInterval(clockTimer); });
</script>
