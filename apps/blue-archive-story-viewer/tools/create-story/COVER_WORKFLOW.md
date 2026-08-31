# Gemini 系列剧情封面工作流

Workbench 的“系列封面”是独立于剧情制作的整组封面工具。它让 Gemini 先通读所选活动章节的
日文原文，规划整组视频封面的情绪节奏和风格轮换，再按章节顺序生成候选。封面不会自动
选择、上传或发布；任何远端图片调用都必须由用户在页面确认。

底层保留两个原子脚本：

- `generate-series-covers.mjs`：系列级规划、顺序调度、进度记录；
- `generate-story-cover.mjs`：单章剧情分析、角色参考图生图、视觉复检。

图片生成全部在项目脚本中完成，不依赖仓库外的 `image_edit.py`、skill 目录或交互式 Agent。

## Workbench 操作

1. 在左侧切换到“系列封面”，输入活动 ID、任一 GroupId 或活动名称；也可以从某章的
   “最终预览 → 剧情封面管理”直接跳转，活动会自动带入。
2. 页面列出该系列全部章节、解析后的标题、日文标题、输入就绪状态、既有候选和当前选择。
3. 默认选择系列中的全部章节；封面任务会直接从原始 Scenario 表和 ba-l10n 导出包含日文的
   独立剧情输入，不要求建立工作区，也不检查字幕、语音、装配、录制或正式剧情进度。
   也可以只选择前几章或任意子集。
4. 可填写整组创作指导，调整分辨率、每章尝试次数、是否补充回忆大厅参考，以及三类模型。
5. 点击生成后，页面会先显示系列级构图分配，再逐章显示生成、QA 或失败状态和实时日志。
6. 任务完成后逐章检查候选，点击“选择此版本”。选择只写入对应剧情工作区，不发布内容。

默认模型：

- 系列规划与单章分析：`gemini-3.7-flash`
- 图片生成：`gemini-3.1-flash-image`
- 视觉复检：`gemini-3.7-flash`

旧浏览器设置中的 `gemini-3.1-flash-image-preview` 会自动迁移到已经转正的
`gemini-3.1-flash-image`。

## 标题解析

标题按以下优先级确定，所有页面共用同一套结果：

1. 本地化活动索引中的章节标题；
2. 当前制作基线或正式剧情 JSON 的 `#title` 行；
3. 如果该章自身确实没有标题，沿用最近一个有标题的章节，并标成 `(2)`、`(3)`。

遇到新的明确标题会重新开始编号。首个明确标题之前若仍无标题，只显示“第 N 话”，不会
凭空继承后面的标题。续集编号只是页面和视频标题元数据，Gemini 仍必须根据本章日文原文
设计不同画面。

## 系列规划规则

系列规划器读取每章完整 `TextJp`，并保留 `ScriptKr` 中的标题、场景和说话人线索。它为每章
选择一个方向：

- `dramatic`：放大本章关系、传闻或冲突；
- `lyrical`：用人物距离、天气、长阴影和冷暖关系表达余韵；
- `easter-egg`：选择合理的可爱主题、反差动作或彩蛋概念；
- `symbolic`：用倒影、影子、旧照片或超现实物件连接主题。

2～3 章至少使用 2 种方向，4 章以上至少使用 3 种方向；3 章以上时相邻章节不得重复同一
方向。规划不满足约束时自动要求 Gemini 修正一次，仍不合格则任务失败，不以重复模板继续。

## 单章生成和视觉 QA

每章只允许使用已经存在
`.local-files/ba-characters/<角色名>/设定集.png` 的角色。默认每名角色只传一张设定图；仅在
勾选后补充 `回忆大厅.png`。参考图约束发型、瞳色、光环、配饰和服装细节，不沿用旧图构图。

生成提示固定要求 16:9、缩略图可读、自然标题负空间，并禁止文字、Logo、水印、UI、对白框、
黑色标题板、伪文字、多余肢体、角色重复和服装串位。视觉复检会检查角色身份与人数、手部、
透视、安全裁切、意外文字和剧情关联；不通过时把具体问题交回图片模型，直到达到阈值或用完
尝试次数。`2K`/`4K` 且允许多次尝试时，会先用较低分辨率验证方向，再生成目标分辨率。

自动 QA 不能替代人工检查。最终仍要用原尺寸和视频列表缩略尺寸检查角色、肢体、构图、文字、
裁切与剧情钩子。

## 独立 CLI

Workbench 会自动生成系列输入。需要调试时可执行：

```bash
pnpm generate-series-covers .local-files/path/to/series-input.json \
  --resolution 2K \
  --max-attempts 2
```

单章原子工具仍可独立运行：

```bash
pnpm generate-story-cover path/to/story.json \
  --story-id 10002005 \
  --speaker-config path/to/speakers.json \
  --cover-direction lyrical \
  --resolution 2K
```

完整参数分别见 `pnpm generate-series-covers --help` 和 `pnpm generate-story-cover --help`。
环境需要 `GOOGLE_CLOUD_PROJECT`，可选 `GOOGLE_CLOUD_LOCATION`，使用 Vertex AI 身份认证。

## 产物和清理边界

```text
.local-files/covers/
├── <story-id>-cover-gemini-<run-id>.jpg
├── .runs/<story-id>/<run-id>/
│   ├── manifest.json
│   ├── plan.json
│   ├── attempt-01.jpg
│   └── attempt-01-qa.json
└── .series-runs/<event-id>/<run-id>/
    ├── series-plan.json
    └── manifest.json

.local-files/create-story/_cover-batches/<batch-id>/
├── batch.json
├── input.json
├── params.json
├── japanese-stories/<story-id>.json
├── result.json
└── log.txt
```

这些文件是可复查的制作记录，不属于 `tmp`，不会自动清理。每次运行产生新 `run-id`，不会
覆盖旧候选；页面只列顶层最佳候选，不让失败尝试挤满人工选择区。
