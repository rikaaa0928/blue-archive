
`create-favor.mjs`: 从学生好感剧情索引模板创建索引

参数：

`args[0]`: 学生ID
`args[1]`: 分布类型，默认 0
`args[2]`: 分布模式，默认为空数组

分布类型：

- 0: 正常分布
- 1: 有爱用品
- 2: 自定义分布，此时传入使用空格分隔的故事组 ID

示例：

```bash
pnpm create-favor 10000 0 # 在对应目录创建一个包含 *02, *03, *05, *06 的索引
pnpm create-favor 10000 1 # 在对应目录创建一个包含 *02, *03, *05, *06, *15 的索引
pnpm create-favor 10000 2 1 2 3 # 在对应目录创建一个包含 *01, *02, *03 的索引
```

## 完整处理剧情

`process-story.mjs` 按顺序执行完整发布流水线：

1. 从 GL `ScenarioScriptDBSchema.json` 导入完整故事，并用 ba-l10n 补空语言字段；
   已有 JSON 时跳过，以便续跑。
2. 使用 Vertex Gemini 补齐 `TextJpVoice`。
3. 准备角色参考音频、上传参考声音、创建并轮询 ZeroTTS 任务、下载语音。
4. 上传生成语音到 Cloudflare R2，并把 `VoiceJp` 改写为公网 URL。

```bash
pnpm process-story 1102
pnpm process-story 1102 --schema /path/to/ScenarioScriptDBSchema.json
pnpm process-story 1102 --limit 2
pnpm process-story 1102 --force
pnpm process-story 1102 --changed-only
```

`--limit` 同时限制本次 LLM 文本数和 TTS 台词数，适合短验证。再次不带
`--force` 运行时，会从 JSON 和本地 manifest 中的现有进度继续。
使用 `--changed-only` 时，只重新生成并发布当前 `TextJpVoice` 与上次成功
发布文本不同的语音。

## 精准同步原始 GL 剧情表

先构建固定版本的下载器镜像，再运行项目入口：

```bash
docker build \
  -t ba-asset-downloader:v2.3.0 \
  CICD/create-story/docker

pnpm sync-ba-story-data
```

该入口只下载 `ExcelDB.db`，只导出剧情、活动和角色解析需要的六张 JSON，不会同步
整个 Table catalog 中的战斗地图等资源。数据根目录默认由
`BA_ASSET_DATA_DIR` 或 `BA_SCENARIO_SCHEMA_PATH` 推导，也可显式指定：

```bash
pnpm sync-ba-story-data --data-dir /absolute/path/ba-asset-data-global
pnpm sync-ba-story-data --skip-download
```

首次在新数据目录运行仍需由上游从客户端 runtime 生成当前版本对应的解析 schema。
容器设计、缓存、安全边界和上游升级检查见
[`docker/README.md`](./docker/README.md)。

## 从原始 GL Table 导入完整剧情

`import-ba-raw-story.mjs` 默认读取 Blue Archive Global Table 解码出的
`ScenarioScriptDBSchema.json`，按 `GroupId` 生成
`public/story/<type>/<id>.json`。原始 Table 始终是剧情帧、演出和行顺序的唯一
骨架；导入器默认访问 `ba-l10n.cnfast.top`，只补充原始行中为空的语言字段。

原始记录中的全部无对白演出帧、`ScriptKr`、日文、选择项、BGM、音效、背景、
等待、转场和额外字段都会保留。GL 同时提供官方繁中、英文和泰文，分别写入
`TextTw`、`TextEn` 和 `TextTh`。GL 没有简中，`TextCn` 默认从 ba-l10n 的
`g_tw_cn` 补充；任何已有官方非空文本都不会被 ba-l10n 覆盖。

ba-l10n 仍未提供 `TextCn` 时，繁中回退转换会先用当前 GL 角色表的
`NameTW`/`NicknameTW` 与播放器实际从 CDN 加载的
`ScenarioCharacterNameExcelTable.json` 的 `NameCN`/`NicknameCN` 按
`CharacterName` 哈希生成规范名称映射，然后用 OpenCC `tw2sp` 转换其余正文。
CDN 表按播放器相同的一小时粒度缓存到 `.local-files/player-data/`。名称按长度从长到短
匹配，避免组合名被较短的单人名提前替换；有多个候选译名的歧义项不会自动替换。
没有角色立绘或头像的舞台标签也不会进入正文名称映射。

该规则覆盖单名以及正文中的“姓氏 + 名字”组合，例如 `千紗 → 和纱`、
`杏山千紗 → 杏山和纱`。`ScenarioCharacterNameExcelTable.json` 本身没有姓氏字段；
LLM 终审会再读取播放器 `public/config/yaml/students.yaml` 中同一角色的
`familyName`、`name`。映射唯一且至少两个字符的姓氏会与名字一起先做确定性替换，
因此 `宇沢 → 宇泽` 这类 OpenCC 无法识别的日式字形不交给模型猜测；单字姓/名
可能与普通正文碰撞，跳过预替换，仅作为带姓氏、名字、全名分类的权威上下文交给
LLM 判断。这里不读取 story editor 的 `src/assets/students.json`。

确定性转换完成后，导入器默认再调用 `gemini-3.1-pro-preview`，以 `MEDIUM`
thinking level 对整章 `TextCn` 连续做两遍保守校对。第二遍以第一遍结果为新的
`currentTextCn`，并强制重新请求模型，不会因为输入没有变化就直接复用第一遍刚写入的
缓存。实践中第一遍主要修正语义、术语和断裂姓名，第二遍还能补出繁中把女性统一写成
“他”后遗留的指代问题。可用 `--cn-proofread-passes <n>` 调整导入遍数，独立脚本对应
`--passes <n>`；默认值均为 2。

日文是语义依据，繁中是翻译参考，播放器角色名映射是姓名规范依据；
模型只修正有来源或上下文证据的误译、漏译、指代、术语和姓名转换问题，不做文风
润色。姓名因口吃、停顿、重复、简称或标点而拆开的片段也会结合上下文统一处理，
因此不依赖为某个角色编写一次性替换规则。每批结果必须覆盖全部目标行，并通过
换行数、播放器标记和特殊标点序列校验后才能写回。每遍都会逐行独立核对第三人称
代词，不机械继承繁中“他”；姓名表中的学生角色按女性处理，同时不会误改“其他”或
“他人”等普通词。
当前目标行包含 JP、TW 和待校对 CN；前后文与整章压缩概览只提供 JP/TW、说话人
和索引，避免错误简中上下文误导模型。代码还会拒绝无来源英文及专名间隔号、引号、
横线等纯标点样式漂移。

模型响应缓存在 `.local-files/cn-proofread-cache/`，逐行修改报告写到
`.local-files/cn-proofread-reports/`；报告包含每一遍的修改及最终净变化。离线诊断时可以显式加
`--no-cn-llm-proofread`；正常导入不应跳过终审。已有剧情也可单独运行：

```bash
pnpm proofread-text-cn public/story/event/10014
```

两遍 Gemini 输出是待审候选，不是流程终点。随后必须由 LLM agent 做一次最终把关：

1. 逐条对照 `git diff` 中的旧 CN、新 CN、`TextJp` 和 `TextTw`，模型 rationale 只能作
   提示，不能替代原文证据。
2. 检查断裂姓名、姓氏、女性指代、官方社团/学校术语、地区用词、漏译和模型过度改写；
   播放器 `public/config/yaml/students.yaml` 是姓名、所属和社团简中名称的权威来源。
3. 明确的小问题直接最小幅度修改 `TextCn`；发现模型无依据改变主语、单复数、标点、
   换行或标签时直接回退该处。不要为了某一行给通用 prompt 添加一次性指令。
4. 最终再次运行差异校验、残留模式扫描、测试和 `git diff --check`。只有全部通过后，
   才能进入 TTS、录制或发布流程。

独立终审在处理每个 JSON 前会把原文件备份到系统临时目录。两遍模型完成后先在内存中
校验一次，只允许 `content[*].TextCn` 与顶层 `proofreader` 变化；原子写回后再由
`verify-cn-proofread-diff.mjs` 对 tmp 备份和磁盘成品做第二次校验。剧情行数、顺序、
演出、语音、选择项或任何其他字段变化都会导致命令失败；如果磁盘校验失败，脚本
会先从备份恢复原文件再退出。也可以手动复核任意两个文件：

```bash
pnpm verify-cn-proofread-diff /tmp/before.json /path/to/after.json
```

两套数据不能按数组下标合并。导入器使用规范化后的日文文本和原始顺序匹配，
支持 HTML ruby 转播放器 ruby，并会拆分、重新合并 `[s]`、`[s1]` 等选择项。
下载结果缓存在：

```text
.local-files/ba-l10n/story/<source-kind>/<story-id>.json
```

示例：

```bash
pnpm import-ba-raw-story 1101 \
  --schema /Volumes/storage/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json \
  --type group \
  --dry-run
```

默认复用缓存，且缓存或远端 ba-l10n 无法读取时会终止导入。需要更新或明确离线时：

```bash
pnpm import-ba-raw-story 1101 --type group --refresh-ba-l10n --dry-run
pnpm import-ba-raw-story 1101 --type group --no-ba-l10n --dry-run
pnpm import-ba-raw-story 1101 --type group \
  --ba-l10n-input /path/to/ba-l10n-1101.json --dry-run
```

固定服务配置也可以放在应用或仓库 `.env`：

```dotenv
BA_L10N_BASE_URL=https://ba-l10n.cnfast.top
BA_L10N_SOURCE_KIND=normal
# BA_L10N_DISABLE=1
# CN_PROOFREAD_MODEL=gemini-3.1-pro-preview
# CN_PROOFREAD_THINKING_LEVEL=MEDIUM
# CN_PROOFREAD_PASSES=2
# CN_PROOFREAD_DISABLE=1  # 仅用于明确的离线诊断
```

常用参数：

- `--type <main|other|favor|event|group|mini>`：输出剧情类型，默认 `main`
- `--out-id <id>`：输出剧情 ID，默认使用源章节 ID
- `--directory-id <id>`：输出到 `favor/event/group/mini` 这类分目录剧情时指定目录 ID
- `--schema <file>`：完整 schema 或单组 `content` 导出
- `--refresh-ba-l10n`：忽略缓存，重新获取补充翻译
- `--no-ba-l10n`：完全离线，只使用原始 Table
- `--require-ba-l10n`：兼容旧命令；现在 ba-l10n 无法读取时默认就会终止
- `--ba-l10n-input <file>`：使用本地 ba-l10n JSON，便于复现和测试
- `--dry-run`：只打印转换统计，不写文件
- `--force`：覆盖已存在的输出文件

导入器不会读取或合并任何已有 viewer JSON。目标文件存在且没有传 `--force`
时会直接拒绝覆盖；传入 `--force` 会完全以原始 Table 重建，旧翻译、
`VoiceJp` 和 `TextJpVoice` 不会保留。

活动剧情可以先按活动 ID、日文名或韩文名查询：

```bash
pnpm find-event-story 801
pnpm find-event-story 桜花
pnpm find-event-story 10000005
pnpm --silent find-event-story 벚꽃 --json
```

`find-event-story.mjs` 从 `BA_SCENARIO_SCHEMA_PATH` 同目录的活动表和本地化表
解析活动名称、原版/复刻关系以及按顺序排列的剧情 `GroupId`。也可以通过
`--schema` 或 `--table-dir` 指向另一套服务器数据。数字没有命中活动 ID 时会
自动作为剧情 `GroupId` 反查；`--group-id` 可以强制使用反查模式。

活动章节导入后，用同一个活动 ID 或任意章节 GroupId 生成前端入口：

```bash
pnpm generate-event-story-index 10014005 --place trinity
```

生成结果写入 `src/index/eventStoryIndex.generated.json`，并与已有手工索引一起
展示。脚本从 ba-l10n 获取活动及章节的六语言标题和简介，缓存位于
`.local-files/ba-l10n/index/event/`。默认只收录已经导入到
`public/story/event/` 的章节；重新运行会按 `event_id` 替换旧条目，不会重复
追加。常用选项：

- `--refresh-ba-l10n`：刷新活动 manifest、键表和多语言字符串缓存
- `--dry-run`：打印生成结果，不写索引
- `--include-missing`：同时生成尚无剧情 JSON 的章节入口，通常不建议
- `--schema` / `--table-dir`：临时使用另一套活动表

## 生成日语配音情绪稿

`enrich-story-with-llm.mjs`: 调用 Vertex Gemini，为已导入的剧情补齐：

- `TextJpVoice`：基于原始 `TextJp` 插入情绪 tag 的日语配音稿

当前 enrichment 只生成配音稿，不翻译空的 `TextCn`。脚本会把剧情标题、地点、
角色表、现有中文文本、全局剧情大纲、
目标行前后文、脚本 cue、音效和 BGM 一起提供给 LLM，避免只按单句标注。

情绪 tag 支持自由格式的英文自然语言描述，`shared-config.mjs` 中的
`voiceTagExamples` 只用于启发模型，不是允许列表。试听后确认的人工调音文本
可以加入 `textJpVoiceOverrides`；导入时会按剧情 ID 以及预期的
`TextJp`、`ScriptKr` 精确校验，LLM 阶段即使使用 `--force` 也不会覆盖。
源文本发生变化或匹配不唯一时脚本会直接报错，要求人工更新配置。

包含 `[s]`、`[s1]` 等标记的选项行保持空的 `TextJpVoice` 和 `VoiceJp`，
不会交给 LLM 或 TTS 生成语音。

示例：

```bash
pnpm enrich-story-llm 1101 --type group
```

先小批量测试：

```bash
pnpm enrich-story-llm 1101 --type group --limit 5
```

只查看处理计划，不调用 Vertex、不写文件：

```bash
pnpm enrich-story-llm 1101 --type group --dry-run
```

常用参数：

- `--type <main|other|favor|event|group|mini>`：剧情类型，默认 `group`
- `--directory-id <id>`：分目录剧情的目录 ID，默认取剧情 ID 前 5 位
- `--model <model>`：Vertex Gemini 模型，默认 `gemini-3.5-flash-lite`
- `--project <id>`：Vertex 项目 ID，默认读取环境变量
- `--location <location>`：Vertex 地区，默认读取环境变量或 `us-central1`
- `--batch-size <n>`：每次调用处理的文本行数，默认 `12`
- `--context-radius <n>`：目标批次前后提供多少条文本上下文，默认 `8`
- `--limit <n>`：最多处理多少条，便于试跑
- `--force`：重做已经存在 `TextJpVoice` 的行
- `--output <file>`：写入另一个 JSON 文件，默认覆盖源文件

## ZeroTTS 语音生成流水线

`voice-zero-tts.mjs`: 读取剧情 JSON 的 `TextJpVoice`，按角色准备参考音频，并调用 ZeroTTS 生成每句日语语音。

脚本分阶段执行，所有中间状态保存在 `.local-files/tts/<type>/<storyId>/voice-zero-tts-manifest.json`，可以中断后继续。

所有故事共用的角色参考音频保存在
`.local-files/tts/references/<韩文名_资源名>/`。同一角色只生成一套
`reference.mp3`、`reference.txt` 和 `reference-manifest.json`。

参考音频来源默认使用项目内部目录：

```text
.local-files/ba-characters
```

`download-ba-character.mjs` 是原 `download.py` 的 Node.js 等价实现，不依赖
外部 Python 项目或第三方 Node 包。它支持角色查询、立绘、回忆大厅、设定集、
日配语音与文本下载：

```bash
pnpm download-ba-character 晴奈
pnpm download-ba-character --list
```

下载器是人工补充本地资源的独立工具，不参与剧情角色身份解析或 TTS 运行。
TTS 缺少本地角色目录时会直接报错并停止，由人工补齐后再继续。

先只准备参考音频，不联网：

```bash
pnpm voice-zero-tts 1101 --type group --stage prepare
```

准备并上传参考声音：

```bash
ZERO_TTS_API_KEY=... pnpm voice-zero-tts 1101 --type group --stage upload
```

创建任务并轮询下载：

```bash
ZERO_TTS_API_KEY=... pnpm voice-zero-tts 1101 --type group --stage all
```

下载完成后，脚本会把每句生成音频写到本地工作目录，并在 manifest
中记录 `audioPath`、生成文本和文本 SHA-256。R2 上传成功后还会记录
`publishedText`、`publishedTextHash` 和发布时间：

```text
.local-files/tts/group/1101/lines/0006.mp3
```

ZeroTTS 阶段不会修改剧情 JSON 的 `VoiceJp`。随后
`publish-voice-r2.mjs` 从 manifest 读取已完成音频，上传到 R2 后直接写入公网 URL。

常用参数：

- `--stage <prepare|upload|tasks|poll|all>`：执行阶段，默认 `prepare`
- `--limit <n>`：只处理前 n 句，用于小样本测试
- `--force`：重建参考音频、重建任务或覆盖已下载音频
- `--changed-only`：只处理相对上次成功发布发生变化的 `TextJpVoice`
- `--model <model>`：ZeroTTS 模型，默认 `zerotts-v1`
- `--character-root <dir>`：本地角色参考资源根目录
- `--speaker-map <file>`：极少数目录名不等于播放器 `NameCN` 时指定目录名
- `--reference-min <n>`：每个角色参考音频最低总秒数，默认 `20`
- `--reference-max <n>`：每个角色参考音频最高总秒数，默认 `60`
- `--reference-min-clip <n>`：单条参考音频最低秒数，默认 `5`
- `--reference-gap <n>`：参考片段拼接间隔秒数，默认 `0.8`

导入、情绪稿、特殊说话人配置和 TTS 共用 `scenario-script-speakers.mjs` 解析
`ScriptKr`。具名角色完全沿用播放器流程：韩文脚本标识经
`xxhash32(seed=0)` 得到 `CharacterName`，再查询播放器 CDN 的
`ScenarioCharacterNameExcelTable.json`。TTS 直接用该记录的 `NameCN` 定位
`.local-files/ba-characters/<NameCN>/`，运行时不查询 GameKee，也不做另一套别名
匹配。`--speaker-map` 只覆盖本地目录名，不改变播放器角色身份。

## 发布语音到 Cloudflare R2

`publish-voice-r2.mjs`: 从 ZeroTTS manifest 读取本地生成音频，上传到 R2，
并把 `VoiceJp` 直接写成 R2 公网 URL。

这个步骤设计为本地执行。仓库中只提交改写后的 story JSON，不提交 `.local-files` 音频目录；Cloudflare Pages 部署 Action 只负责构建和发布静态站，不负责生成或上传语音。

需要先在 Cloudflare R2 创建 bucket，并给 bucket 配置公开访问域名，然后配置环境变量：

```bash
CLOUDFLARE_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=...
R2_PUBLIC_BASE_URL=https://assets.example.com
```

示例：

```bash
pnpm publish-voice-r2 1101 --type group
```

只检查将要上传和改写的内容：

```bash
R2_PUBLIC_BASE_URL=https://assets.example.com pnpm publish-voice-r2 1101 --type group --dry-run
```

如果音频已经手动上传过，只想改写 JSON：

```bash
pnpm publish-voice-r2 1101 --type group --skip-upload
```

默认对象 key 前缀是：

```text
ba-story-viewer/tts/group/1101/lines/0006.mp3
```

对应写入 `VoiceJp` 的 URL 是：

```text
https://assets.example.com/ba-story-viewer/tts/group/1101/lines/0006.mp3
```
