# 剧情制作工具与本地数据

本目录保留可独立运行的原子脚本。日常编排入口是
`../create-story-workbench/`；启动方式见 [`START.md`](./START.md)，唯一的详细流程说明见
[`INDEPENDENT_TRACK_WORKFLOW.md`](./INDEPENDENT_TRACK_WORKFLOW.md)。
Gemini 封面工具的创意规则、操作和产物说明见
[`COVER_WORKFLOW.md`](./COVER_WORKFLOW.md)。

脚本之间不通过交互提示猜测参数，也不在录制时偷偷修改默认分支。录制默认分支由
`preselect-options.mjs` 原子写入，`validate-recording-selections.mjs` 只读校验，
`run-record.sh` 在校验通过后才开始构建、采集和转码。

## `.local-files` 顶层目录

`.local-files/` 已被 Git 忽略，用于下载缓存、制作记录和本地产物，不用于保存密钥。

| 目录 | 用途 | 清理边界 |
| --- | --- | --- |
| `ba-characters/` | 角色日语语音、台词和图片原始资源 | 可重新下载但体积大，不建议删除 |
| `ba-l10n/` | ba-l10n 剧情和活动索引缓存 | 可重建；删除会影响离线复现 |
| `player-data/` | 播放器角色名等表缓存 | 可重建；不要手改 |
| `cn-proofread-cache/` | 按模型和输入摘要保存的 LLM 请求缓存 | 重跑有费用且结果会漂移，保留 |
| `cn-proofread-reports/` | 旧流程中文审核报告 | 仅作历史证据；新版不读取 |
| `tts/` | 公共参考音、旧任务与音频缓存 | 不随剧情版本删除；远端对象也不受本地清理影响 |
| `covers/` | Gemini/人工封面候选、生成审计记录与选择结果 | 正式本地产物，不按缓存清理 |
| `create-story/` | 新版剧情工作区、独立支线记录、任务日志和录制产物 | 制作事实来源，不整体删除 |
| `tmp/` | 可丢弃的构建目录和故障恢复文件 | 无任务运行时可安全清空 |

## 新版剧情工作区

```text
.local-files/create-story/
├── _batches/<batch-id>/
└── event/10002/10002005/
    ├── workspace.json
    ├── jobs/<job-id>/
    └── versions/v002/production/
        ├── state.json
        ├── base-story.json
        ├── tracks/
        │   ├── cn/
        │   │   ├── current.json
        │   │   ├── llm-runs/
        │   │   └── edits/
        │   └── voice/
        │       ├── speakers.json
        │       ├── speaker-edits/
        │       ├── references.json
        │       ├── reference-edits/
        │       ├── script.json
        │       ├── script-runs/
        │       ├── script-edits/
        │       └── tts/
        ├── assembly/
        ├── branch-decisions.json
        ├── branch-edits/
        ├── preview.json
        ├── preview-video.mp4
        ├── event-index.json
        └── recording.json
```

`vNNN` 只代表一次大规模推倒重做。同一版本内的中文、说话人、参考音和配音稿修改分别写入
自己的增量记录，不复制完整剧情。字幕线和语音线只在最终装配时合并。

新版不读取旧版的顶层 `artifacts/`、`drafts/`、`resources/` 和旧 revision 审批状态。这些
目录可以在对应剧情的新版完整生成、录制和验收之后按剧情清理；清理前不要连带删除共享的
`ba-characters/`、`cn-proofread-cache/`、`tts/references/` 或远端对象。

## `tmp/` 约束

典型内容包括 `cn-proofread/run-*/`、`create-story-workbench-ui/`、`recording-logs/` 和
`story-backups/`。`tmp/` 中的内容不得成为审批状态、续跑依据或后续步骤的唯一输入。

中文校对临时备份只用于一轮运行中断后的恢复，整轮成功后可以删除；前端构建目录下次启动会
重建。确认没有任务运行时，清空 `tmp/` 不得影响任何已完成版本的复查、继续制作或录制。

## 独立 CLI 边界

- `sync-ba-story-data.mjs`：准备原始表，不下载角色语音。
- `import-ba-raw-story.mjs`：从原始表导入剧情骨架和多语言文本。
- `fill-text-cn-from-tw.mjs`：固定的繁转简与名称规范化。
- `proofread-text-cn-with-llm.mjs`：中文 LLM 校对，可指定模型和指导意见。
- `enrich-story-with-llm.mjs`：生成日语配音稿，只允许表演或情绪提示。
- `download-ba-character.mjs`：下载角色原始资源。
- `voice-zero-tts.mjs`：准备参考音与增量生成语音；不会代替资源下载。
- `publish-voice-r2.mjs`：上传已有语音并回填剧情所需 URL，不发布视频。
- `generate-event-story-index.mjs`：更新活动剧情索引。
- `preselect-options.mjs`、`validate-recording-selections.mjs`：写入与校验录制默认分支。
- `generate-series-covers.mjs`：通读所选活动章节的日文原文，规划整组封面风格轮换并按顺序调度生成。
- `generate-story-cover.mjs`：单章分析、参考图生图和视觉复检；由系列工具调用，也可独立调试。

工作台可以依次触发这些能力，但每个脚本本身保持单一职责。
