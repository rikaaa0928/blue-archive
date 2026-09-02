<template>
  <section class="production-workbench">
    <div v-if="loading && !loaded" class="stage-card">正在读取新版制作产物…</div>

    <section v-else-if="!exists" class="stage-card production-empty">
      <p class="eyebrow">INDEPENDENT TRACKS</p>
      <h2>为当前大版本建立干净的制作基线</h2>
      <p class="stage-description">
        自动导入原始剧情；若播放器目录已有同一剧情，会在逐行结构校验后继承已完成的字幕、配音稿和语音。
      </p>
      <button class="primary" :disabled="busy" @click="run('production-prepare')">
        {{ busy ? '自动准备中…' : '自动准备当前片段' }}
      </button>
    </section>

    <template v-else>
      <section v-if="section === 'production-overview'" class="production-grid">
        <article class="track-card shared">
          <p class="eyebrow">SHARED BASE</p><h2>自动准备</h2>
          <strong>{{ production.base.rows }} 行 · {{ shortDigest(production.base.digest) }}</strong>
          <span v-if="production.base.baseline?.adopted">已复用存量：{{ production.base.baseline.inherited.TextCn }} 行字幕 · {{ production.base.baseline.preservedVoiceIndices.length }} 条语音</span>
          <span v-else>固定原稿、繁转简、名称规范化已完成</span>
        </article>
        <article class="track-card cn">
          <p class="eyebrow">CN TRACK</p><h2>简中字幕</h2>
          <strong>{{ cnStateLabel }}</strong>
          <span>{{ production.cn.generationCount }} 次整体生成 · {{ production.cn.editCount }} 次人工微调</span>
          <button class="ghost small" @click="emit('navigate', 'production-cn')">进入字幕线</button>
        </article>
        <article class="track-card voice">
          <p class="eyebrow">VOICE TRACK</p><h2>克隆语音</h2>
          <strong>{{ voiceStateLabel }}</strong>
          <span>说话人、参考音和配音稿分别保存</span>
          <button class="ghost small" @click="emit('navigate', 'production-voice')">进入语音线</button>
        </article>
        <article class="track-card final">
          <p class="eyebrow">ASSEMBLY</p><h2>最终预览</h2>
          <strong>{{ production.assembly.current ? '装配产物为最新' : '等待装配或上游有改动' }}</strong>
          <span>结构、跳转、默认分支仅在这里检查</span>
          <button class="ghost small" @click="emit('navigate', 'production-final')">进入最终预览</button>
        </article>
      </section>

      <section v-else-if="section === 'production-cn'" class="stage-card">
        <div class="stage-heading">
          <div><p class="eyebrow">CN SUBTITLE TRACK</p><h2>简中字幕</h2></div>
          <span :class="['badge', production.cn.ready ? 'completed' : 'ready']">{{ cnStateLabel }}</span>
        </div>
        <p class="stage-description">两轮 LLM 负责整体校对；整体通过后，人工微调区永久可编辑。微调只会使最终装配失效，不会影响语音线。</p>

        <div class="production-toolbar">
          <label>简中校对模型<input v-model.trim="cnModel" placeholder="gemini-3.7-flash" /></label>
          <label class="wide">整体重做指导意见<textarea v-model="cnGuidance" rows="2" placeholder="不满意时补充方向，再重新生成全部字幕" /></label>
          <button class="primary" :disabled="busy" @click="generateCn">
            {{ production.cn.generationCount ? '按指导整体重新生成' : '运行两轮 LLM 校对' }}
          </button>
        </div>

        <details v-if="production.cn.llmRuns?.length" class="history-box" open>
          <summary>LLM 生成记录（{{ production.cn.llmRuns.length }}）</summary>
          <nav class="run-selector" aria-label="简中字幕候选方案">
            <button v-for="run in [...production.cn.llmRuns].reverse()" :key="run.id" :class="{ active: selectedCnRunId === run.id }" @click="selectCnRun(run.id)">
              <b>方案 {{ cnRunNumber(run) }}</b>
              <small>{{ run.model || '默认模型' }} · {{ formatTime(run.generatedAt) }}</small>
              <span v-if="production.cn.approvedRunId === run.id">✓ 已确认</span>
            </button>
          </nav>
          <article v-if="selectedCnRun" class="cn-run-detail">
            <header><b>方案 {{ cnRunNumber(selectedCnRun) }} · {{ selectedCnRun.id }}</b><small>{{ selectedCnRun.model || '默认模型' }} · {{ formatTime(selectedCnRun.generatedAt) }}</small></header>
            <p v-if="selectedCnRun.guidance">指导：{{ selectedCnRun.guidance }}</p>
            <div class="history-change" v-for="change in selectedCnRun.result?.changes || []" :key="`${selectedCnRun.id}-${change.pass}-${change.index}`">
              <b>#{{ change.index }} · 第 {{ change.pass }} 轮</b>
              <div v-if="storyRow(change.index)" class="history-source-reference">
                <p><span>日文原文</span><em lang="ja">{{ storyRow(change.index).TextJp || '（无）' }}</em></p>
                <p><span>繁中原文</span><em>{{ storyRow(change.index).TextTw || '（无）' }}</em></p>
              </div>
              <del>{{ change.before }}</del><ins>{{ change.after }}</ins>
              <small>{{ (change.issueTypes || []).join(' / ') }}<template v-if="change.rationale"> · {{ change.rationale }}</template></small>
            </div>
          </article>
        </details>

        <div v-if="production.cn.ready || production.cn.generationCount" class="fine-tune-head">
          <div><h3>{{ production.cn.ready ? '人工微调' : '当前字幕整体审查 · 方案 ' + cnRunNumber(selectedCnRun) }}</h3><small>{{ production.cn.ready ? '随时可进入；只记录实际发生变化的行' : '逐行对照当前选中方案；确认后才进入人工微调' }}</small></div>
          <div class="cn-review-actions"><input v-model.trim="query" placeholder="筛选行号或文本" /><button v-if="!production.cn.ready" class="accept" :disabled="busy || cnRunLoading || !selectedCnRunId" @click="approveCn">确认采用此方案</button><button v-else-if="production.cn.lastRunId" class="reject" :disabled="busy" @click="revokeCnApproval">撤销确认并清除微调（{{ production.cn.editCount }}）</button><span v-else class="completed-copy">✓ 已采用现有 Viewer 字幕基线</span></div>
        </div>
        <div v-if="production.cn.ready || production.cn.generationCount" class="production-lines cn-comparison-lines">
          <article v-for="row in filteredCnRows" :key="row.index" :class="{ changed: production.cn.ready && cnDraft[row.index] !== row.TextCn }">
            <b>#{{ row.index }}</b>
            <div class="language-cell"><span>日文原文</span><p lang="ja">{{ row.TextJp || '（无）' }}</p></div>
            <div class="language-cell tw"><span>繁中原文</span><p>{{ row.TextTw || '（无）' }}</p></div>
            <div class="language-cell cn"><span>简中字幕</span><textarea v-if="production.cn.ready" v-model="cnDraft[row.index]" rows="2" /><p v-else>{{ row.TextCn || '（无）' }}</p></div>
          </article>
        </div>
        <div v-if="production.cn.ready" class="save-bar">
          <label>本次人工编辑说明<input v-model.trim="cnEditNote" placeholder="必填，例如：根据最终录制节奏缩短字幕" /></label>
          <button class="primary" :disabled="!cnChangedCount" @click="saveCn">保存 {{ cnChangedCount }} 处增量编辑</button>
        </div>
        <HistoryList title="人工字幕编辑记录" :records="production.cn.edits" />
      </section>

      <section v-else-if="section === 'production-voice'" class="voice-stack">
        <section class="stage-card">
          <div class="stage-heading"><div><p class="eyebrow">SPEAKERS & REFERENCES</p><h2>说话人与参考音</h2></div><span :class="['badge', production.voice.speakers.ready ? 'completed' : 'ready']">{{ speakerStateLabel }}</span></div>
          <p class="stage-description">角色信息库可唯一匹配且有日语语音时自动确认。这里仅列出未知、团体、NPC、无语音或多候选等例外。</p>
          <button v-if="!production.voice.speakers.scannedAt" class="primary" :disabled="busy" @click="run('production-speaker-scan')">自动识别说话人</button>
          <div v-else class="speaker-review-layout">
            <div class="speaker-exceptions">
              <article v-for="item in humanSpeakers" :key="item.stableKey" :class="{ active: activeSpeakerKey === item.stableKey }">
                <header class="speaker-exception-heading">
                  <div><b>{{ item.sourceSpeaker || '???' }}</b><small>{{ speakerIndices(item).length }} 处台词 · {{ item.reason }}</small></div>
                  <div class="speaker-occurrences">
                    <button v-for="index in speakerIndices(item)" :key="index" :class="['ghost', 'small', { active: activeSpeakerKey === item.stableKey && selectedSpeakerIndex(item) === index }]" @click="locateSpeaker(item, index)">▶ #{{ index }}</button>
                  </div>
                </header>
                <div class="speaker-context-lines">
                  <div v-for="row in speakerContextRows(item)" :key="row.index" :class="{ target: row.index === selectedSpeakerIndex(item) }">
                    <b>#{{ row.index }}</b>
                    <p lang="ja">{{ row.TextJp || '（无日文显示文本）' }}</p>
                    <p>{{ row.TextTw || '（无繁中显示文本）' }}</p>
                    <p>{{ row.TextCn || '（无简中显示文本）' }}</p>
                  </div>
                </div>
                <div class="speaker-resolution-fields">
                  <select v-model="speakerDraft[item.stableKey].type">
                    <option value="character">映射到角色</option><option value="npc">使用预制 NPC 音色</option><option v-if="item.reason === 'collective-speaker'" value="collective">团体发言成员</option>
                  </select>
                  <input v-if="speakerDraft[item.stableKey].type === 'character'" v-model.trim="speakerDraft[item.stableKey].stableKey" list="known-speaker-keys" placeholder="韩文稳定 key" @input="fillSpeakerCharacterName(item)" @change="fillSpeakerCharacterName(item)" />
                  <input v-if="speakerDraft[item.stableKey].type === 'character'" v-model.trim="speakerDraft[item.stableKey].characterName" placeholder="中文名" />
                  <input v-if="speakerDraft[item.stableKey].type === 'collective'" v-model.trim="speakerDraft[item.stableKey].membersText" placeholder="韩文稳定 key，逗号分隔" />
                  <button class="primary small" @click="saveSpeaker(item)">保存判断</button>
                </div>
              </article>
              <p v-if="!humanSpeakers.length" class="completed-copy">✓ 所有说话人均已自动确认，无需逐条审批</p>
            </div>
            <aside v-if="humanSpeakers.length" class="speaker-context-player">
              <div class="section-title"><div><h3>剧情播放器定位</h3><small v-if="locatedSpeakerIndex !== null">播放器已定位 #{{ locatedSpeakerIndex }}，可前后播放确认出场角色</small><small v-else-if="activeSpeakerIndex !== null">当前查看 #{{ activeSpeakerIndex }}；点击行号后定位播放器</small></div><label class="player-mute-toggle"><input v-model="speakerPlayerMuted" type="checkbox" /> 静音</label></div>
              <StoryPlayer v-if="speakerContextStory" :key="speakerContextPlayerKey" :story="speakerContextStory" :change-index="speakerPlayerIndex" :width="640" :height="360" data-url="https://yuuka.cdn.diyigemt.com/image/ba-all-data" language="Cn" user-name="老师" :story-summary="{ chapterName: String(speakerContextStory.GroupId || ''), summary: '' }" :use-mp3="true" :muted="speakerPlayerMuted" @initiated="handleSpeakerPlayerInitiated" @error="emit('error', $event)" />
              <div v-else class="player-placeholder">正在载入当前剧情播放器…</div>
              <p class="muted">点击左侧任意“▶ #行号”会在同一个播放器内定位，不会重新从剧情开头播放。</p>
            </aside>
          </div>
          <datalist id="known-speaker-keys"><option v-for="item in knownSpeakers" :key="item.stableKey" :value="item.stableKey">{{ item.characterName }}</option></datalist>
          <div class="reference-summary">
            <div><b>参考音</b><small>{{ production.voice.references.ready ? '已有选择，可随时进入微调' : '等待一键自动准备' }}</small></div>
            <button class="primary" :disabled="!production.voice.speakers.ready || busy" @click="run('production-reference-prepare')">一键拉取并自动选择</button>
            <button class="ghost" :disabled="!production.voice.references.ready" @click="referenceOpen = !referenceOpen">{{ referenceOpen ? '收起微调' : '预览与修改' }}</button>
          </div>
          <div v-if="referenceOpen" class="reference-editor">
            <aside>
              <button v-for="speaker in referenceSpeakers" :key="speaker.stableKey" :class="['ghost', { active: activeReferenceSpeaker === speaker.stableKey }]" @click="loadReference(speaker.stableKey)">{{ speaker.characterName }}<small>{{ speaker.stableKey }}</small></button>
            </aside>
            <section v-if="referenceDetail">
              <div class="section-title"><div><h3>{{ referenceDetail.characterName }}</h3><small>已选 {{ referenceSelected.size }} 段，可试听后调整</small></div><button class="primary small" @click="saveReference">保存选择</button></div>
              <article v-for="clip in referenceDetail.clips" :key="clip.name">
                <label><input type="checkbox" :checked="referenceSelected.has(clip.name)" @change="toggleReference(clip.name, $event.target.checked)" /> {{ clip.name }}</label>
                <p>{{ clip.text }}</p><audio controls preload="none" :src="clip.audioUrl" />
              </article>
            </section>
            <p v-else class="muted">选择一个角色查看自动选择结果。参考音改动只使该角色相关语音和最终装配失效。</p>
          </div>
        </section>

        <section class="stage-card">
          <div class="stage-heading"><div><p class="eyebrow">VOICE SCRIPT</p><h2>日语配音稿</h2></div><span :class="['badge', production.voice.script.ready ? 'completed' : 'ready']">{{ scriptStateLabel }}</span></div>
          <p class="stage-description">整体生成只添加与表演有关的情绪提示。整体通过后，人工文本与“无语音”标记都在永久微调区增量保存。</p>
          <div class="production-toolbar">
            <label>配音稿模型<input v-model.trim="scriptModel" placeholder="gemini-3.7-flash" /></label>
            <label class="wide">整体重做指导意见<textarea v-model="scriptGuidance" rows="2" /></label>
            <button class="primary" :disabled="busy" @click="generateScript">{{ production.voice.script.generationCount ? '按指导整体重新生成' : '生成日语配音稿' }}</button>
          </div>
          <details v-if="production.voice.script.llmRuns?.length" class="history-box" open>
            <summary>配音稿生成记录（{{ production.voice.script.llmRuns.length }}）</summary>
            <nav class="run-selector" aria-label="日语配音稿候选方案">
              <button v-for="run in [...production.voice.script.llmRuns].reverse()" :key="run.id" :class="{ active: selectedScriptRunId === run.id }" @click="selectScriptRun(run.id)">
                <b>方案 {{ scriptRunNumber(run) }}</b>
                <small>{{ run.model || '默认模型' }} · {{ formatTime(run.generatedAt) }}</small>
                <span v-if="production.voice.script.approvedRunId === run.id">✓ 已确认</span>
              </button>
            </nav>
            <article v-if="selectedScriptRun" class="cn-run-detail">
              <header><b>方案 {{ scriptRunNumber(selectedScriptRun) }} · {{ selectedScriptRun.id }}</b><small>{{ selectedScriptRun.model || '默认模型' }} · {{ formatTime(selectedScriptRun.generatedAt) }}</small></header>
              <p v-if="selectedScriptRun.guidance">指导：{{ selectedScriptRun.guidance }}</p>
              <div class="history-change voice-history-change" v-for="change in selectedScriptRun.result?.changes || []" :key="`${selectedScriptRun.id}-${change.index}`">
                <b>#{{ change.index }}</b><del>{{ change.before }}</del><ins>{{ change.after }}</ins>
              </div>
            </article>
          </details>
          <div v-if="production.voice.script.ready || production.voice.script.generationCount" class="fine-tune-head">
            <div><h3>{{ production.voice.script.ready ? '配音稿人工微调' : '当前配音稿整体审查 · 方案 ' + scriptRunNumber(selectedScriptRun) }}</h3><small>{{ production.voice.script.ready ? '日文原文与中文仅供参考；保存时记录实际改动' : '逐行查看当前选中方案；确认后才进入人工微调' }}</small></div>
            <div class="cn-review-actions"><input v-model.trim="query" placeholder="筛选行号、日文、中文或配音稿" /><button v-if="!production.voice.script.ready" class="accept" :disabled="busy || scriptRunLoading || !selectedScriptRunId" @click="approveScript">确认采用此方案</button><button v-else-if="production.voice.script.lastRunId" class="reject" :disabled="busy" @click="revokeScriptApproval">撤销确认并清除微调（{{ production.voice.script.editCount }}）</button><span v-else class="completed-copy">✓ 已采用现有 Viewer 配音基线</span></div>
          </div>
          <div v-if="production.voice.script.ready || production.voice.script.generationCount" class="production-lines voice-lines">
            <article v-for="row in filteredRows" :key="row.index" :class="{ changed: production.voice.script.ready && scriptDraft[row.index] !== row.TextJpVoice }">
              <b>#{{ row.index }}</b><div class="source-languages"><p><span>日文原文</span><em lang="ja">{{ row.TextJp || '（无）' }}</em></p><p><span>中文参考</span><em>{{ row.TextCn || '（无）' }}</em></p></div>
              <textarea v-if="production.voice.script.ready" v-model="scriptDraft[row.index]" rows="2" lang="ja" />
              <div v-else class="voice-script-preview"><span>生成的配音稿</span><p lang="ja">{{ row.TextJpVoice || '（无配音稿）' }}</p></div>
              <label v-if="production.voice.script.ready" class="skip-control"><input type="checkbox" :checked="skippedSet.has(row.index)" @change="toggleSkip(row.index, $event.target.checked)" /> 不生成语音</label>
              <span v-else-if="skippedSet.has(row.index)" class="skip-pill">无语音</span>
            </article>
          </div>
          <div v-if="production.voice.script.ready" class="save-bar">
            <label>本次配音稿编辑说明<input v-model.trim="scriptEditNote" placeholder="必填" /></label>
            <button class="primary" :disabled="!scriptChangedCount" @click="saveScript">保存 {{ scriptChangedCount }} 处增量编辑</button>
          </div>
          <HistoryList title="人工配音稿编辑记录" :records="production.voice.script.edits" />
        </section>

        <section class="stage-card">
          <div class="stage-heading"><div><p class="eyebrow">TTS & R2</p><h2>生成、试听与上传</h2></div></div>
          <p class="stage-description">说话人与参考音、配音稿两项前置完成后才生成。后续局部修改只重建受影响的行。</p>
          <button class="primary" :disabled="!voicePrerequisitesReady || busy" @click="run('production-tts')">增量生成并上传语音</button>
          <span v-if="production.voice.tts.exists" :class="['badge', production.voice.tts.current ? 'completed' : 'ready']">{{ production.voice.tts.completed }}/{{ production.voice.tts.total }} 条完成{{ production.voice.tts.current ? '' : ' · 上游已改动' }}</span>
          <div v-if="ttsLines.length" class="tts-audio-list production-audio-list">
            <article v-for="line in ttsLines" :key="line.index" :class="{ skipped: line.skipped, failed: line.status === 'FAILED' }">
              <b class="tts-line-index">#{{ line.index }}</b>
              <div class="tts-line-copy"><strong>{{ line.speaker }}</strong><p>{{ line.textCn }}</p><small>{{ line.ttsText }}</small><em v-if="line.error">{{ line.error }}</em></div>
              <span v-if="line.skipped" class="skip-pill">无语音</span>
              <audio v-else-if="line.audioReady" controls preload="none" :src="line.audioUrl" />
              <span v-else class="badge ready">{{ line.status }}</span>
            </article>
          </div>
        </section>
      </section>

      <section v-else class="stage-card">
        <div class="stage-heading"><div><p class="eyebrow">FINAL ASSEMBLY & PREVIEW</p><h2>装配与最终预览</h2></div><span :class="['badge', production.assembly.current ? 'completed' : 'ready']">{{ production.assembly.current ? '产物最新' : '需要重新装配' }}</span></div>
        <p class="stage-description">在这里才检查剧情结构、选择页跳转、录制默认分支和完整播放。默认分支修改只影响预览与录制，不创建新的大版本。</p>
        <div class="final-readiness">
          <span :class="{ yes: production.cn.ready }">简中字幕</span><span :class="{ yes: production.voice.speakers.ready }">说话人</span><span :class="{ yes: production.voice.references.ready }">参考音</span><span :class="{ yes: production.voice.script.ready }">配音稿</span>
        </div>
        <button class="primary" :disabled="!assemblyReady" @click="assemble">重新装配当前产物</button>
        <div v-if="production.assembly.current" class="final-review-grid">
          <section>
            <div v-if="production.assembly.inspection.errors.length" class="notice error"><b>结构检查失败</b><span>{{ production.assembly.inspection.errors.join('；') }}</span></div>
            <div v-else class="notice success"><b>结构扫描通过</b><span>未发现缺失的选择响应入口</span></div>
            <article v-for="choice in production.assembly.inspection.choices" :key="choice.index" class="choice-review">
              <b>选择页 #{{ choice.index }}</b>
              <label v-for="option in choice.options.filter(item => item.selectionGroup > 0)" :key="option.key">
                <input type="checkbox" :checked="checkedBranches.has(option.key)" @change="setBranchChecked(option.key, $event.target.checked)" />
                <span>{{ option.textCn || option.textJp }}<small>Group {{ option.selectionGroup }} → #{{ option.responseIndex }}</small></span>
                <input type="radio" :name="`default-${choice.index}`" :checked="Number(production.preview.branches.defaultSelectionGroups[choice.index]) === option.selectionGroup" @change="setDefaultBranch(choice.index, option.selectionGroup)" /> 默认录制
              </label>
            </article>
          </section>
          <section class="final-player-frame">
            <div class="section-title"><div><h3>最终预览视频</h3><small>按默认录制分支生成；支持拖动、暂停和反复查看</small></div><span v-if="production.recording.current" class="badge completed">完整性验收通过</span></div>
            <video v-if="production.recording.current" :key="recordingVideoUrl" controls preload="metadata" :src="recordingVideoUrl" />
            <div v-else class="player-placeholder">{{ finalRecordingReady ? '分支已准备好，可以生成预览视频' : '请先完成左侧分支确认与默认录制选择' }}</div>
            <div v-if="production.recording.current" class="recording-output">
              <div><b>当前版本视频</b><code>{{ production.recording.output }}</code></div>
              <div v-if="production.recording.sourceOutput"><b>录制脚本原始输出</b><code>{{ production.recording.sourceOutput }}</code></div>
              <a class="ghost small" :href="recordingVideoUrl" target="_blank" rel="noopener">打开视频</a>
              <button class="ghost small" @click="revealRecording">在 Finder 中显示</button>
            </div>
            <div class="final-preview-actions">
              <button class="primary" :disabled="!finalRecordingReady || busy" @click="run('production-record', { subtitle: 'cn' })">{{ production.recording.current ? '重新生成预览视频' : '生成预览视频' }}</button>
              <button v-if="production.recording.current && !production.preview.complete" class="accept" :disabled="busy" @click="completePreview">确认视频预览通过</button>
              <span v-if="production.preview.complete" class="completed-copy">✓ 当前视频已人工确认</span>
            </div>
            <p class="muted">发现问题时直接返回简中字幕、配音稿或参考音微调；重新装配后当前视频和确认状态会自动过期。</p>
          </section>
        </div>
        <div v-if="production.preview.complete" class="publish-warning"><b>预览视频已确认</b><p>现在可以把同一份装配写入播放器使用的正式剧情目录；不会再次录制视频。</p><button class="primary" @click="materializeStory">生成正式剧情文件</button><span v-if="production.publicArtifact.current" class="completed-copy">✓ 正式文件与当前装配一致</span></div>
        <section v-if="production.publicArtifact.current" class="post-production">
          <div class="section-title"><div><p class="eyebrow">POST PRODUCTION</p><h2>录制与收尾</h2></div><small>每一步都有独立产物判定</small></div>
          <article><b>01</b><div><strong>正式剧情 JSON</strong><small>当前装配已经写入 public/story</small></div><span class="badge completed">已完成</span></article>
          <article v-if="isEventStory"><b>02</b><div><strong>活动索引</strong><small>同一活动未完成全部章节时也可重复更新</small></div><span :class="['badge', production.eventIndex.current ? 'completed' : 'ready']">{{ production.eventIndex.current ? '已更新' : '待执行' }}</span><button class="ghost" :disabled="busy" @click="run('production-event-index')">更新活动索引</button></article>
          <article><b>03</b><div><strong>录制默认分支</strong><small>来自上方最终分支确认，录制前由原子脚本写入并再次校验</small></div><span class="badge completed">已确认</span></article>
          <article><b>04</b><div><strong>简中视频</strong><small>最终预览使用的视频即为正式录制产物</small></div><span class="badge completed">已录制并确认</span></article>
          <article><b>05</b><div><strong>视频产物验收</strong><small>ffprobe 元数据检查与 FFmpeg 全量解码</small><template v-if="production.recording.current"><code>{{ production.recording.output }}</code></template></div><span :class="['badge', production.recording.current ? 'completed' : 'locked']">{{ production.recording.current ? '验收通过' : '等待录制' }}</span></article>
          <article><b>06</b><div><strong>剧情封面</strong><small>录制完成后选择或上传当前片段的正式封面</small></div><span :class="['badge', status?.cover.complete ? 'completed' : 'ready']">{{ status?.cover.complete ? '已选择' : '待选择' }}</span></article>
          <p class="muted">流程在通过完整性验收的 MP4 和封面产物处结束，不包含视频发布步骤。</p>
        </section>
        <CoverPanel
          v-if="production.publicArtifact.current"
          :workspace-id="workspaceId"
          @open-cover-studio="emit('open-cover-studio', status?.workspace.identity.storyId)"
          @error="emit('error', $event)"
        />
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onMounted, ref, watch } from "vue";
import StoryPlayer from "ba-story-player";
import CoverPanel from "./CoverPanel.vue";

const props = defineProps({ workspaceId: String, section: String, busy: Boolean, latestJob: Object, status: Object });
const emit = defineEmits(["run", "error", "navigate", "changed", "open-cover-studio"]);
const exists = ref(false); const production = ref(null); const loaded = ref(false); const loading = ref(false);
const legacyModel = localStorage.getItem("story-workbench-llm-model") || "gemini-3.7-flash";
const cnModel = ref(localStorage.getItem("story-workbench-cn-llm-model") || "gemini-3.1-pro-preview");
const scriptModel = ref(localStorage.getItem("story-workbench-voice-script-llm-model") || legacyModel);
const cnGuidance = ref(""); const scriptGuidance = ref(""); const query = ref("");
const cnDraft = ref({}); const scriptDraft = ref({}); const speakerDraft = ref({});
const selectedCnRunId = ref(""); const selectedCnRun = ref(null); const cnRunLoading = ref(false);
const selectedScriptRunId = ref(""); const selectedScriptRun = ref(null); const scriptRunLoading = ref(false);
const cnEditNote = ref(""); const scriptEditNote = ref(""); const referenceOpen = ref(false);
const ttsLines = ref([]);
const activeReferenceSpeaker = ref(""); const referenceDetail = ref(null); const referenceSelected = ref(new Set());
const speakerContextStory = ref(null); const speakerPlayerIndex = ref(undefined);
const activeSpeakerKey = ref(""); const activeSpeakerIndex = ref(null); const speakerOccurrenceSelection = ref({});
const speakerPlayerReady = ref(false); const pendingSpeakerIndex = ref(null); const locatedSpeakerIndex = ref(null);
const speakerPlayerMuted = ref(true);

const HistoryList = defineComponent({ props: { title: String, records: Array }, setup(inner) { return () => h("details", { class: "history-box" }, [h("summary", `${inner.title}（${inner.records?.length || 0}）`), ...(inner.records || []).slice().reverse().map(record => h("article", [h("header", [h("b", record.id), h("small", formatTime(record.editedAt))]), h("p", record.note || "无说明"), h("pre", JSON.stringify(record.changes || record.skipDecision || {}, null, 2))]))]); } });

async function api(suffix, options = {}) { const response = await fetch(`/api/workspaces/${encodeURIComponent(props.workspaceId)}/production${suffix}`, { headers: { "Content-Type": "application/json" }, ...options }); const payload = await response.json(); if (!response.ok) throw new Error(payload.message || payload.error); return payload; }
async function load() { if (!props.workspaceId) return; loading.value = true; try { const payload = await api(""); exists.value = payload.exists; production.value = payload.production; syncDrafts(); await syncSelectedCnRun(); await syncSelectedScriptRun(); if (production.value?.voice.tts.exists) await loadTtsLines(); else ttsLines.value = []; if (props.section === "production-voice" && production.value?.voice.speakers.scannedAt) await loadSpeakerContextStory(); loaded.value = true; } catch (cause) { emit("error", cause); } finally { loading.value = false; } }
async function loadTtsLines() { const payload = await api("/tts/lines"); ttsLines.value = payload.lines; }
async function loadSpeakerContextStory() { if (speakerContextStory.value) return; speakerContextStory.value = (await api("/context-story")).story; }
function syncDrafts() { if (!production.value) return; cnDraft.value = Object.fromEntries(production.value.story.map(row => [row.index, row.TextCn])); scriptDraft.value = Object.fromEntries(production.value.story.map(row => [row.index, row.TextJpVoice])); speakerDraft.value = Object.fromEntries(production.value.voice.speakers.items.map(item => [item.stableKey, { type: item.resolution?.type || (item.reason === "collective-speaker" ? "collective" : "character"), stableKey: item.resolution?.stableKey || "", characterName: item.resolution?.characterName || "", membersText: (item.resolution?.members || []).join(", ") }])); const first = humanSpeakers.value[0]; if (first && !activeSpeakerKey.value) { activeSpeakerKey.value = first.stableKey; activeSpeakerIndex.value = speakerIndices(first)[0] ?? null; speakerOccurrenceSelection.value[first.stableKey] = activeSpeakerIndex.value; } }
function run(action, params = {}) { emit("run", action, params); }
function persistModel(target, storageKey) { if (!target.value) target.value = "gemini-3.7-flash"; localStorage.setItem(storageKey, target.value); return target.value; }
async function mutate(suffix, method, body) { try { await api(suffix, { method, body: JSON.stringify(body) }); await load(); emit("changed"); } catch (cause) { emit("error", cause); } }
function generateCn() { const model = persistModel(cnModel, "story-workbench-cn-llm-model"); run("production-cn-generate", { model, guidance: cnGuidance.value, refreshCache: Boolean(production.value.cn.generationCount) }); }
function generateScript() { const model = persistModel(scriptModel, "story-workbench-voice-script-llm-model"); run("production-voice-script-generate", { model, guidance: scriptGuidance.value }); }
function approveCn() { mutate("/cn/approve", "POST", { runId: selectedCnRunId.value }); } function approveScript() { mutate("/voice-script/approve", "POST", { runId: selectedScriptRunId.value }); }
function revokeCnApproval() { const count = Number(production.value?.cn.editCount || 0); if (!window.confirm(`撤销当前简中方案确认，并永久清除 ${count} 条人工微调记录？LLM 生成方案不会删除。`)) return; mutate("/cn/revoke-approval", "POST", {}); }
function revokeScriptApproval() { const count = Number(production.value?.voice.script.editCount || 0); if (!window.confirm(`撤销当前配音稿方案确认，并永久清除 ${count} 条人工微调记录和手动无语音标记？LLM 生成方案不会删除。`)) return; mutate("/voice-script/revoke-approval", "POST", {}); }
const scriptReviewRows = computed(() => { const rows = production.value?.story || []; if (production.value?.voice.script.ready || !selectedScriptRun.value?.rows) return rows; return rows.map(row => ({ ...row, TextJpVoice: selectedScriptRun.value.rows[row.index]?.text ?? row.TextJpVoice })); });
const filteredRows = computed(() => { const rows = scriptReviewRows.value; const needle = query.value.toLowerCase(); return needle ? rows.filter(row => String(row.index) === needle || [row.TextJp, row.TextTw, row.TextCn, row.TextJpVoice].some(value => String(value).toLowerCase().includes(needle))) : rows; });
const cnReviewRows = computed(() => { const rows = production.value?.story || []; if (production.value?.cn.ready || !selectedCnRun.value?.rows) return rows; return rows.map(row => ({ ...row, TextCn: selectedCnRun.value.rows[row.index]?.text ?? row.TextCn })); });
const filteredCnRows = computed(() => { const needle = query.value.toLowerCase(); return needle ? cnReviewRows.value.filter(row => String(row.index) === needle || [row.TextJp, row.TextTw, row.TextCn].some(value => String(value).toLowerCase().includes(needle))) : cnReviewRows.value; });
function storyRow(index) { return production.value?.story.find(row => Number(row.index) === Number(index)); }
function cnRunNumber(run) { if (!run) return "–"; const index = production.value?.cn.llmRuns?.findIndex(candidate => candidate.id === run.id) ?? -1; return index >= 0 ? index + 1 : "–"; }
function normalizeCnRunId(value) { return String(value || "").replace(/\.json$/u, ""); }
async function selectCnRun(runId) { const normalizedId = normalizeCnRunId(runId); if (!normalizedId || selectedCnRun.value?.id === normalizedId && selectedCnRun.value?.rows) return; cnRunLoading.value = true; try { selectedCnRunId.value = normalizedId; selectedCnRun.value = (await api(`/cn/runs/${encodeURIComponent(normalizedId)}`)).run; } catch (cause) { emit("error", cause); } finally { cnRunLoading.value = false; } }
async function syncSelectedCnRun() { const runs = production.value?.cn.llmRuns || []; if (!runs.length) { selectedCnRunId.value = ""; selectedCnRun.value = null; return; } const preferred = normalizeCnRunId(production.value.cn.approvedRunId || production.value.cn.lastRunId || runs.at(-1).id); if (!runs.some(run => run.id === selectedCnRunId.value) || production.value.cn.ready) selectedCnRunId.value = preferred; await selectCnRun(selectedCnRunId.value); }
function scriptRunNumber(run) { if (!run) return "–"; const index = production.value?.voice.script.llmRuns?.findIndex(candidate => candidate.id === run.id) ?? -1; return index >= 0 ? index + 1 : "–"; }
async function selectScriptRun(runId) { const normalizedId = normalizeCnRunId(runId); if (!normalizedId || selectedScriptRun.value?.id === normalizedId && selectedScriptRun.value?.rows) return; scriptRunLoading.value = true; try { selectedScriptRunId.value = normalizedId; selectedScriptRun.value = (await api(`/voice-script/runs/${encodeURIComponent(normalizedId)}`)).run; } catch (cause) { emit("error", cause); } finally { scriptRunLoading.value = false; } }
async function syncSelectedScriptRun() { const runs = production.value?.voice.script.llmRuns || []; if (!runs.length) { selectedScriptRunId.value = ""; selectedScriptRun.value = null; return; } const preferred = normalizeCnRunId(production.value.voice.script.approvedRunId || production.value.voice.script.lastRunId || runs.at(-1).id); if (!runs.some(run => run.id === selectedScriptRunId.value) || production.value.voice.script.ready) selectedScriptRunId.value = preferred; await selectScriptRun(selectedScriptRunId.value); }
const cnChangedCount = computed(() => (production.value?.story || []).filter(row => cnDraft.value[row.index] !== row.TextCn).length);
const scriptChangedCount = computed(() => (production.value?.story || []).filter(row => scriptDraft.value[row.index] !== row.TextJpVoice).length);
function saveCn() { const changes = production.value.story.filter(row => cnDraft.value[row.index] !== row.TextCn).map(row => ({ index: row.index, text: cnDraft.value[row.index] })); mutate("/cn", "PATCH", { changes, note: cnEditNote.value }); }
function saveScript() { const changes = production.value.story.filter(row => scriptDraft.value[row.index] !== row.TextJpVoice).map(row => ({ index: row.index, text: scriptDraft.value[row.index] })); mutate("/voice-script", "PATCH", { changes, note: scriptEditNote.value }); }
const humanSpeakers = computed(() => production.value?.voice.speakers.items.filter(item => item.requiresHuman) || []);
const speakerContextPlayerKey = computed(() => `${props.workspaceId}:${production.value?.base.digest || "context"}`);
function speakerIndices(item) { return [...new Set((item.storyIndices || (Number.isSafeInteger(item.storyIndex) ? [item.storyIndex] : [])).map(Number).filter(Number.isSafeInteger))]; }
function selectedSpeakerIndex(item) { return Number.isSafeInteger(speakerOccurrenceSelection.value[item.stableKey]) ? speakerOccurrenceSelection.value[item.stableKey] : (speakerIndices(item)[0] ?? null); }
function speakerContextRows(item) { const index = selectedSpeakerIndex(item); const rows = (production.value?.story || []).filter(row => row.TextJp || row.TextTw || row.TextCn); const position = rows.findIndex(row => row.index === index); if (position < 0) return (production.value?.story || []).slice(Math.max(0, index - 2), index + 3); return rows.slice(Math.max(0, position - 2), position + 3); }
async function applySpeakerPlayerIndex(index) { speakerPlayerIndex.value = undefined; await nextTick(); window.setTimeout(() => { speakerPlayerIndex.value = index; locatedSpeakerIndex.value = index; }, 300); }
async function locateSpeaker(item, index) { activeSpeakerKey.value = item.stableKey; activeSpeakerIndex.value = index; speakerOccurrenceSelection.value = { ...speakerOccurrenceSelection.value, [item.stableKey]: index }; await loadSpeakerContextStory(); if (!speakerPlayerReady.value) { pendingSpeakerIndex.value = index; return; } await applySpeakerPlayerIndex(index); }
async function handleSpeakerPlayerInitiated() { speakerPlayerReady.value = true; if (!Number.isSafeInteger(pendingSpeakerIndex.value)) return; const index = pendingSpeakerIndex.value; pendingSpeakerIndex.value = null; await applySpeakerPlayerIndex(index); }
const knownSpeakers = computed(() => { const byKey = new Map(); for (const item of production.value?.voice.speakers.items || []) if (item.resolution?.type === "character") byKey.set(item.resolution.stableKey, item.resolution); return [...byKey.values()]; });
const referenceSpeakers = computed(() => { const byKey = new Map(knownSpeakers.value.map(item => [item.stableKey, item])); for (const item of production.value?.voice.speakers.items || []) { if (item.resolution?.type === "collective") for (const stableKey of item.resolution.members || []) if (!byKey.has(stableKey)) byKey.set(stableKey, { stableKey, characterName: stableKey }); } return [...byKey.values()]; });
function fillSpeakerCharacterName(item) { const draft = speakerDraft.value[item.stableKey]; if (!draft || draft.type !== "character") return; const known = knownSpeakers.value.find(candidate => candidate.stableKey === draft.stableKey); if (known) draft.characterName = known.characterName; }
function saveSpeaker(item) { fillSpeakerCharacterName(item); const draft = speakerDraft.value[item.stableKey]; const resolution = draft.type === "collective" ? { type: "collective", members: draft.membersText.split(/[,，\s]+/u).filter(Boolean) } : draft; mutate(`/speakers/${encodeURIComponent(item.stableKey)}`, "PATCH", { resolution, note: "人工确认说话人例外" }); }
async function loadReference(stableKey) { try { activeReferenceSpeaker.value = stableKey; referenceDetail.value = await api(`/references/${encodeURIComponent(stableKey)}`); referenceSelected.value = new Set(referenceDetail.value.selected); } catch (cause) { emit("error", cause); } }
function toggleReference(name, checked) { const next = new Set(referenceSelected.value); if (checked) next.add(name); else next.delete(name); referenceSelected.value = next; }
async function saveReference() { const stableKey = activeReferenceSpeaker.value; try { await api(`/references/${encodeURIComponent(stableKey)}`, { method: "PUT", body: JSON.stringify({ selected: [...referenceSelected.value], note: `人工微调 ${stableKey} 参考音` }) }); await load(); await loadReference(stableKey); } catch (cause) { emit("error", cause); } }
const skippedSet = computed(() => new Set(production.value?.voice.script.effectiveSkippedIndices || []));
function toggleSkip(index, skipped) { mutate("/voice-script/skip", "POST", { index, skipped }); }
async function assemble() { await mutate("/assemble", "POST", {}); }
const checkedBranches = computed(() => new Set(production.value?.preview.branches.checkedSelectionKeys || []));
const finalRecordingReady = computed(() => { const current = production.value; if (!current?.assembly.current || current.assembly.inspection.errors.length) return false; const branches = current.preview.branches; const choices = current.assembly.inspection.choices; const allChecked = choices.flatMap(choice => choice.options.filter(option => option.selectionGroup > 0).map(option => option.key)).every(key => checkedBranches.value.has(key)); const allDefaulted = choices.every(choice => { const options = choice.options.filter(option => option.selectionGroup > 0); return !options.length || options.some(option => option.selectionGroup === Number(branches.defaultSelectionGroups[choice.index])); }); return allChecked && allDefaulted; });
const recordingVideoUrl = computed(() => `/api/workspaces/${encodeURIComponent(props.workspaceId)}/production/recording/video?v=${encodeURIComponent(production.value?.recording.completedAt || '')}`);
async function revealRecording() { try { await api("/recording/reveal", { method: "POST", body: "{}" }); } catch (cause) { emit("error", cause); } }
function setBranchChecked(key, checked) { const next = new Set(checkedBranches.value); if (checked) next.add(key); else next.delete(key); mutate("/branches", "PATCH", { checkedSelectionKeys: [...next] }); }
function setDefaultBranch(index, selectionGroup) { mutate("/branches", "PATCH", { defaultSelectionGroups: { [index]: selectionGroup } }); }
function completePreview() { mutate("/preview/complete", "POST", {}); }
async function materializeStory() { if (!window.confirm("将当前装配生成到 public/story，作为播放器和录制输入，确认继续？")) return; await mutate("/formal-story", "POST", { confirmed: true }); }
const cnStateLabel = computed(() => production.value?.cn.ready ? (production.value.cn.approvalSource === "existing-viewer-baseline" ? "已采用存量基线" : "整体通过，可随时微调") : !production.value?.cn.generationCount ? "等待 LLM" : "等待整体审查");
const speakerStateLabel = computed(() => !production.value?.voice.speakers.scannedAt ? "尚未扫描" : production.value.voice.speakers.ready ? "自动确认完成" : `${production.value.voice.speakers.unresolvedCount} 个例外待处理`);
const scriptStateLabel = computed(() => production.value?.voice.script.ready ? (production.value.voice.script.approvalSource === "existing-viewer-baseline" ? "已采用存量基线" : "整体通过，可随时微调") : !production.value?.voice.script.generationCount ? "等待生成" : "等待整体审查");
const voicePrerequisitesReady = computed(() => production.value?.voice.speakers.ready && production.value?.voice.references.ready && production.value?.voice.script.ready);
const voiceStateLabel = computed(() => voicePrerequisitesReady.value ? "前置任务已完成" : [speakerStateLabel.value, scriptStateLabel.value].join(" · "));
const assemblyReady = computed(() => production.value?.cn.ready && voicePrerequisitesReady.value && production.value?.voice.tts.voiceStoryReady);
const isEventStory = computed(() => props.status?.workspace?.identity?.type === "event");
function shortDigest(value) { return String(value || "").replace("sha256:", "").slice(0, 10); } function formatTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : ""; }

watch(() => props.workspaceId, () => { speakerContextStory.value = null; speakerPlayerReady.value = false; pendingSpeakerIndex.value = null; locatedSpeakerIndex.value = null; activeSpeakerKey.value = ""; selectedCnRunId.value = ""; selectedCnRun.value = null; selectedScriptRunId.value = ""; selectedScriptRun.value = null; load(); }); watch(() => props.section, next => { if (next !== "production-voice") { speakerPlayerReady.value = false; locatedSpeakerIndex.value = null; return; } if (production.value?.voice.speakers.scannedAt) loadSpeakerContextStory().catch(cause => emit("error", cause)); }); watch(() => props.latestJob?.status, (next, previous) => { if (next && next !== "running" && previous === "running") load(); });
onMounted(load);
</script>
