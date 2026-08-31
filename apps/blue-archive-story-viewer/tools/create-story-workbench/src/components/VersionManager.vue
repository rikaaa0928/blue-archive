<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <section class="version-dialog">
      <div class="stage-heading">
        <div><p class="eyebrow">PRODUCTION VERSIONS</p><h2>大版本管理</h2></div>
        <button class="ghost" @click="$emit('close')">关闭</button>
      </div>
      <p class="version-help">同一大版本内的字幕、说话人、参考音和配音稿各自保留增量记录。只有需要推倒重来时才新建大版本；新版本不会继承旧流程状态。</p>

      <div class="version-list">
        <article v-for="version in status.workspace.versions" :key="version.id" :class="{ active: version.active }">
          <div>
            <b>{{ version.label }} <code>{{ version.id }}</code></b>
            <small>{{ formatTime(version.createdAt) }}</small>
            <small v-if="version.parentVersionId">由 {{ version.parentVersionId }} 新开</small>
          </div>
          <span v-if="version.active" class="badge completed">当前版本</span>
          <button v-else class="ghost" :disabled="busy" @click="activate(version.id)">切换并继续</button>
        </article>
      </div>

      <form class="rework-form" @submit.prevent="createRework">
        <h3>新建干净的大版本</h3>
        <label>新版本名称<input v-model.trim="label" :placeholder="`例如：${nextVersionLabel} 全量重制`" /></label>
        <p>新版本从原始表重新建立基线。旧版本保持只读可切回，不复制旧审核、TTS 或发布状态。</p>
        <button class="primary" :disabled="busy || submitting">{{ submitting ? '正在创建…' : '确认新建大版本' }}</button>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ workspaceId: string; status: any; busy: boolean }>();
const emit = defineEmits(["close", "changed", "error"]);
const label = ref("");
const submitting = ref(false);
const nextVersionLabel = computed(() => `版本 ${props.status.workspace.versions.length + 1}`);

async function request(url: string, options: RequestInit) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  return payload;
}

async function activate(versionId: string) {
  try {
    submitting.value = true;
    const payload = await request(
      `/api/workspaces/${encodeURIComponent(props.workspaceId)}/versions/${encodeURIComponent(versionId)}/activate`,
      { method: "POST", body: "{}" },
    );
    emit("changed", { status: payload.status });
  } catch (error) { emit("error", error); }
  finally { submitting.value = false; }
}

async function createRework() {
  if (!window.confirm("确认新建一个完全独立的大版本？旧版本不会被覆盖。")) return;
  try {
    submitting.value = true;
    const payload = await request(
      `/api/workspaces/${encodeURIComponent(props.workspaceId)}/versions/rework`,
      {
        method: "POST",
        body: JSON.stringify({
          label: label.value,
          confirmed: true,
        }),
      },
    );
    emit("changed", { status: payload.status, stage: "production-overview", created: payload.version });
  } catch (error) { emit("error", error); }
  finally { submitting.value = false; }
}

function formatTime(value: string) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "";
}
</script>
