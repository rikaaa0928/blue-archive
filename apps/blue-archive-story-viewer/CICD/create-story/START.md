# 新剧情制作与录像快速指南

本文以 `group` 类型、剧情 ID `1103` 为例。除下载器步骤外，命令均在
`apps/blue-archive-story-viewer` 目录执行。

## 一、本机和新机器的准备

### 已经配置好的本机

当前本机可直接复用：

```text
/Volumes/storage/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json
```

只要该数据版本满足需求，就从下文“导入完整剧情 JSON”开始。需要同步最新版 GL
剧情表时，在仓库根目录执行：

```bash
docker build \
  -t ba-asset-downloader:v2.3.0 \
  apps/blue-archive-story-viewer/CICD/create-story/docker

pnpm -C apps/blue-archive-story-viewer sync-ba-story-data
```

该命令只下载 `ExcelDB.db`，并只解出剧情流程需要的六张表；不会同步数千个战斗
地图等其他 Table 资源。命令会访问外部服务；执行前确认目录、空间、代理和访问
范围。详细设计见 `CICD/create-story/docker/README.md`。

### 一台全新的机器

需要安装 Git、Docker、Node.js、Chrome 和 ffmpeg。克隆仓库后，在仓库根目录
初始化 Rush monorepo：

```bash
CYPRESS_INSTALL_BINARY=0 node common/scripts/install-run-rush.js update
pnpm -C lib/ba-story-player build
```

构建下载器镜像：

```bash
docker build \
  -t ba-asset-downloader:v2.3.0 \
  apps/blue-archive-story-viewer/CICD/create-story/docker
```

准备一个仓库外的数据目录，并将下面的路径替换成真实绝对路径：

```bash
pnpm -C apps/blue-archive-story-viewer sync-ba-story-data \
  --data-dir /absolute/path/ba-asset-data-global
```

目标文件应为：

```text
/absolute/path/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json
```

该文件当前约 268 MB，是整个 `ScenarioScriptDBSchema` 表的 JSON 导出；所有剧情
帧放在同一个数组中，通过 `GroupId` 区分。`import-ba-raw-story.mjs` 会读取它并
只筛选目标 `GroupId`。如果只复制这个文件到新机器，就可以直接导入普通剧情；
如需使用 `find-event-story` 查询活动和进行角色解析，还应复制同目录下另外五张
索引、本地化及角色名称表。

固定路径可以写入 `apps/blue-archive-story-viewer/.env`：

```dotenv
BA_SCENARIO_SCHEMA_PATH=/absolute/path/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json
```

配置后，`import-ba-raw-story` 和调用它的 `process-story` 都可以省略
`--schema`。命令行 `--schema` 优先级最高，其次是进程环境变量和 `.env`。

新机器还需要自行准备不进 Git 的 `.env` 凭据：Vertex、ZeroTTS 和 Cloudflare
R2。`.local-files` 也不进 Git，因此新剧情的 TTS 本地任务和参考音频需要在新
机器上重新建立；已经发布到 R2 的公网语音不受影响。

## 二、从零制作

### 1. 准备原始剧情表

运行项目封装，只同步剧情需要的数据：

```bash
pnpm sync-ba-story-data
```

如果已有 `raw/Table/ExcelDB.db`，只重新生成六张目标 JSON：

```bash
pnpm sync-ba-story-data --skip-download
```

目标产物位于 `<data-dir>/extracted/Table/ExcelDB/`。容器定义、精准过滤原理、
缓存和上游升级注意事项见 `CICD/create-story/docker/README.md`。下载前先确认
输出目录、可用空间、代理和外部服务访问范围；原始数据库、资源文件和密钥都
不能提交进 Git。

### 2. 导入完整剧情 JSON

进入应用目录：

```bash
cd apps/blue-archive-story-viewer
```

#### 查询活动和剧情 GroupId

导入活动剧情前，使用 `find-event-story` 查询按顺序排列的剧情 `GroupId`。
支持以下用法：

```bash
# 按活动 ID 查询，同时显示使用相同剧情的复刻版本
pnpm find-event-story 801

# 按日文名或韩文名模糊查询
pnpm find-event-story 桜花
pnpm find-event-story 벚꽃

# 已知剧情 GroupId 时反查所属活动
pnpm find-event-story 10000005
pnpm find-event-story 10000005 --group-id

# 输出可供 jq 或其他脚本处理的纯 JSON
pnpm --silent find-event-story 벚꽃 --json
```

数字默认先按活动 ID 查询；没有命中时自动按剧情 `GroupId` 反查所属活动。数字
发生冲突时使用 `--group-id` 强制反查。名称匹配会同时搜索日文和韩文，暂不
包含中文活动名。

查询脚本默认从 `BA_SCENARIO_SCHEMA_PATH` 所在目录读取
`EventContentSeasonDBSchema.json`、`EventContentScenarioDBSchema.json` 和
`LocalizeDBSchema.json`。复刻活动会同时显示 `OriginalEventContentId`，没有
独立剧情列表时自动使用原活动的 `GroupId`。

临时查询另一套 Table 时，可以指定 `ScenarioScriptDBSchema.json`，也可以直接
指定三张索引表所在目录：

```bash
pnpm find-event-story 桜花 \
  --schema /path/to/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json

pnpm find-event-story 桜花 \
  --table-dir /path/to/extracted/Table/ExcelDB
```

查询结果中的 `GroupIds` 已按游戏表里的 `Order` 排序。选择目标集，例如
`10000005`，先验证导入：

```bash
pnpm import-ba-raw-story 10000005 \
  --type event \
  --dry-run
```

默认会输出到 `public/story/event/10000/10000005.json`。如需放入其他活动目录，
显式传入 `--directory-id`。

导入活动章节后，生成前端活动索引：

```bash
pnpm generate-event-story-index 10000005 --place trinity
```

参数可以是活动 ID，也可以是其中任意一个剧情 `GroupId`。脚本会自动反查活动、
读取 ba-l10n 的活动和章节标题/简介，并维护
`src/index/eventStoryIndex.generated.json`。默认只收录已经存在于
`public/story/event/` 的章节，未导入的章节会列在 `Missing story JSON` 中，
不会生成点击后 404 的入口。继续导入章节后重新运行同一命令即可更新。

当前前端分组支持 `trinity`、`millennium` 和 `shanhaijing`。首次运行会缓存活动
索引本地化数据到 `.local-files/ba-l10n/index/event/`；需要更新时加
`--refresh-ba-l10n`，只预览不写索引时加 `--dry-run`。只有明确希望提前展示
尚未导入的章节时才使用 `--include-missing`。

#### 导入剧情 JSON

先验证，不写文件：

```bash
pnpm import-ba-raw-story 1103 \
  --schema /Volumes/storage/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json \
  --type group \
  --dry-run
```

确认 `GroupId` 和原始行数正确后正式生成：

```bash
pnpm import-ba-raw-story 1103 \
  --schema /Volumes/storage/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json \
  --type group
```

输出为：

```text
public/story/group/1103/1103.json
```

导入器以 GL raw 为剧情骨架，默认从 ba-l10n 补充 raw 中为空的语言字段，并缓存
到 `.local-files/ba-l10n/`。已有的官方日文、繁中、英文和泰文不会被覆盖。
如果补充后 `TextCn` 仍为空而 `TextTw` 有值，导入器会先把当前 GL 角色表的
`NameTW`/`NicknameTW` 按 `CharacterName` 哈希与播放器实际从 CDN 加载的
`ScenarioCharacterNameExcelTable.json` 的 `NameCN`/`NicknameCN` 对齐。该表按
播放器相同的一小时粒度缓存到 `.local-files/player-data/`。名称按最长匹配优先保护并替换，再用 OpenCC
`tw2sp` 转换其余正文。它只填空值，不会覆盖已有简中；一个繁中名称对应多个简中
名称时会跳过该歧义名称，不凭文本猜测。没有角色立绘/头像的“老师”“声音”等
舞台标签不进入正文名称映射，避免把普通用词误当角色名。
单名及“姓氏 + 名字”全名都会命中该规则，例如 `千紗 → 和纱`、
`杏山千紗 → 杏山和纱`。CDN 的 `ScenarioCharacterNameExcelTable.json` 没有姓氏
字段；预处理会再从播放器 `public/config/yaml/students.yaml` 读取 `familyName` 和
`name`。映射唯一且至少两个字符的姓氏/名字会先确定性替换，所以
`宇沢 → 宇泽` 等 OpenCC 无法处理的日式字形无需模型猜测。单字姓/名为避免误中
普通词而跳过预替换，但仍以姓氏、名字、全名分栏作为 Gemini 权威上下文。该流程
不读取 story editor 的 `src/assets/students.json`。

上述确定性转换之后，导入器默认使用 `gemini-3.1-pro-preview` 配合 `MEDIUM`
thinking level 连续做两遍简中校对。第二遍读取第一遍修改后的 CN，并强制重新请求
模型；即使第一遍没有修改，也不会直接用第一遍刚写入的缓存代替第二次判断。导入器
可用 `--cn-proofread-passes <n>` 调整遍数，独立校对命令对应 `--passes <n>`，默认
均为 2。它以
日文、繁中、当前简中、前后文和播放器角色名表为共同输入，只处理能由这些输入
证明的客观问题，不做普通润色。通用规则要求模型识别因口吃、停顿、重复、简称或
标点而拆开的姓名片段，并统一为同一角色的规范译名；不会为单个剧情或角色硬编码
替换。每一遍还必须逐条复核第三人称代词，不能机械继承繁中泛用的“他”。返回结果
只有在目标行完整、换行数不变且 `[s]`、ruby 等播放器标记和特殊标点序列完全
保留时才会写回。
目标行会提供 JP/TW 和当前待校对 CN；局部前后文与整章概览只提供 JP/TW、说话人
和索引，不暴露可能有误的非目标 CN。校验还会拒绝无来源英文和纯标点样式漂移。

响应缓存位于 `.local-files/cn-proofread-cache/`，逐行改动报告位于
`.local-files/cn-proofread-reports/`；报告会保留两遍各自的修改和最终净变化。已有剧情可以只做校对：

```bash
pnpm proofread-text-cn public/story/event/10014
```

两遍模型结束后，必须再由 LLM agent 做一次最终把关，不能直接进入配音或录制：

1. 对照 `git diff`、`TextJp`、`TextTw` 逐条审查所有实际改句，不把模型理由当作事实。
2. 重点检查断裂姓名/姓氏、女性指代、学校和社团规范名、地区词、漏译以及过度改写；
   姓名、所属和社团简中名称以播放器 `public/config/yaml/students.yaml` 为准。
3. 小问题直接最小幅度修改 `TextCn`；无依据改变主语、单复数、标点、换行或标记的
   输出应回退。prompt 只能增加可推广的缺陷规则，不能为单句写固定操作。
4. 再运行 `verify-cn-proofread-diff.mjs`、残留模式扫描、相关测试和
   `git diff --check`，确认只有 `TextCn/proofreader` 变化后才算完成。

脚本会先把每个原始 JSON 复制到系统 tmp 目录，并在写回前后各检查一次字段差异。
唯一允许变化的是 `content[*].TextCn` 和顶层 `proofreader`；其余任意字段变化、
剧情行增删或顺序变化都会中止处理。写回后的检查若失败，会先从 tmp 备份恢复原
文件。终端会打印备份目录和每章通过校验的 `TextCn` 改动数。独立校验命令为：

```bash
pnpm verify-cn-proofread-diff /tmp/before.json /path/to/after.json
```

需要重新请求模型时使用 `--refresh-cache`。只有明确的离线诊断才在导入时添加
`--no-cn-llm-proofread`；正常导入应保留终审步骤。
缓存和远端 ba-l10n 都无法读取时默认终止导入，不再生成缺少翻译的 JSON。
明确离线导入加 `--no-ba-l10n`，更新缓存加 `--refresh-ba-l10n`。
`--require-ba-l10n` 仅为兼容旧命令而保留。固定镜像站可以通过 `.env` 的
`BA_L10N_BASE_URL` 配置；设置 `BA_L10N_DISABLE=1` 等价于默认使用
`--no-ba-l10n`。

已有剧情无需重新导入或重跑 LLM/TTS，可以单独增量补齐空的 `TextCn`：

```bash
pnpm fill-text-cn 10014005 --type event
```

也可以处理显式文件并先预览：

```bash
pnpm fill-text-cn \
  --input /path/to/story.json \
  --dry-run
```

该脚本使用与播放器一致的“CDN 角色名映射 → OpenCC 正文”顺序，只修改
“`TextCn` 为空且 `TextTw` 非空”的行，其他剧情字段和已有简中保持不变。没有
`TextTw` 的行会保留为空并计入命令输出。

只有迁移明确由 OpenCC 生成的旧剧情时，才加 `--refresh-existing`，用 `TextTw`
重建已有 `TextCn`；该模式不会改动语音、日文稿或演出字段。

也可以直接读取只包含一个剧情的导出：

```bash
pnpm import-ba-raw-story 1103 \
  --schema /private/tmp/scenario-1103-db.json \
  --type group \
  --dry-run
```

导入器不会读取或合并已有 viewer JSON。已有正式 JSON 时，只有明确要完全重建
才添加 `--force`；重建会丢弃旧文件里的翻译、`VoiceJp` 和
`TextJpVoice`。不加 `--force` 时存量文件保持不变。

`.local-files` 中的 ZeroTTS manifest 以数组下标作为任务键；剧情行数或顺序
改变后，旧 manifest 不可直接用于 changed-only 或重新发布。

### 3. 检查剧情数据

重点检查：

- 原始行数和顺序是否正确；
- 无对白的 `ScriptKr` 演出帧是否存在；
- `BGMId`、`Sound`、`Transition`、`BGName`、`BGEffect` 和
  `PopupFileName` 是否保留；
- `[s]`、`[s1]` 等选择页及 `SelectionGroup` 是否完整；
- `TextJp` 换行和 ruby 标签是否能正常显示；
- 新剧情的翻译和配音字段是否按后续流程生成。

GL 原始表提供官方日文、繁中、英文和泰文，分别写入 `TextJp`、`TextTw`、
`TextEn` 和 `TextTh`；不提供简体中文。导入器会从 ba-l10n 的 `g_tw_cn`
补充 `TextCn`，匹配不到的标题、结束帧或版本差异行仍可能为空，应根据 dry-run
输出的 `ba-l10n unmatched` 人工复核。

### 4. 生成日语配音稿

```bash
pnpm enrich-story-llm 1103 --type group --dry-run
pnpm enrich-story-llm 1103 --type group --limit 5
pnpm enrich-story-llm 1103 --type group
```

先人工检查小批量结果，再处理全部台词。试听后确认的固定配音稿写入
`shared-config.mjs` 的 `textJpVoiceOverrides`，不要只改临时产物。

### 5. 生成并发布语音

运行任何 TTS 阶段前，LLM agent 必须先完整阅读
[`COLLECTIVE_VOICE_CONFIG.md`](./COLLECTIVE_VOICE_CONFIG.md)，扫描目标剧情的
全部集体发言和 `???` 未知说话人并创建或更新对应配置。即使确认两类特殊台词都
不存在，也必须保存该剧情的空配置。配置缺失、过期或存在 `needs-review` 时，不得创建 ZeroTTS 任务；
`process-story` 包含 TTS，也必须先完成同一检查。

```bash
pnpm voice-zero-tts 1103 \
  --type group \
  --stage prepare

pnpm voice-zero-tts 1103 \
  --type group \
  --stage all

pnpm publish-voice-r2 1103 --type group --dry-run
pnpm publish-voice-r2 1103 --type group
```

TTS 按播放器 `NameCN` 直接读取 `.local-files/ba-characters/<NameCN>/`；目录
缺失时会停止，不会在生成过程中查询 GameKee 或自动猜测其他名称。

中间文件保存在 `.local-files/tts/group/1103/`。只修改了部分
`TextJpVoice` 时，使用 `voice-zero-tts ... --changed-only` 后再发布。

如果完整流程已经结束，只需要补齐当前 `VoiceJp` 为空的语音，可使用严格局部
模式。它会处理普通角色、显式确认的匿名 NPC、已解析到真实角色的 `???` 台词和
已配置集体发言，但不会重新生成已有 URL 的
台词：

```bash
pnpm voice-zero-tts 10014005 \
  --type event \
  --stage all \
  --missing-only

pnpm publish-voice-r2 10014005 \
  --type event \
  --missing-only
```

发布端的局部模式只上传 manifest 中对应的缺失任务，并且只回填原本为空的目标
`VoiceJp`。运行前仍须完成集体发言与未知说话人配置检查。

### 6. 配置录制选项

原始导入可能改变行号，因此重建带选择页的剧情后必须强制重选：

```bash
node CICD/create-story/preselect-options.mjs groupStory/1103 --force
```

单选页会自动采用唯一选项，多选页会逐个询问。结果写入
`shared-config.mjs` 的 `storyPreSelections`。

### 7. 试播和录像

先显示浏览器检查立绘、选项动画和声音：

```bash
./run-record.sh groupStory/1103 --no-headless
```

再正式录制：

```bash
./run-record.sh groupStory/1103
```

录制始终使用剧情中的日文配音。字幕通过 `--subtitle=all|cn|en` 选择。
默认值是 `all`，因此不传参数时会顺序生成“日文配音 + 中文字幕”和
“日文配音 + 英文字幕”两个版本：

```bash
./run-record.sh groupStory/1103

# 与默认行为相同
./run-record.sh groupStory/1103 --subtitle=all
```

只生成中文字幕版本时使用：

```bash
./run-record.sh groupStory/1103 --subtitle=cn
```

需要“日文配音 + 英文字幕”时使用：

```bash
./run-record.sh groupStory/1103 --subtitle=en
```

字幕参数可以和 `--no-headless`、`--reselect` 一起使用。

活动剧情同样只传剧情 ID；脚本会根据 ID 前五位自动找到活动目录：

```bash
./run-record.sh eventStory/10014005
```

也兼容显式目录形式 `eventStory/10014/10014005`，两者使用同一个
`eventStory/10014005` 录制预选择配置。

需要在录制前重新选择：

```bash
./run-record.sh groupStory/1103 --reselect
```

中英文版本会共用一次构建和同一个 Vite 服务，但为了避免两个 1920×1080
录制任务争抢 CPU/GPU 而导致掉帧，视频会按中文、英文的顺序依次录制。

成品位于 `scripts/record-story/videos/`。中文字幕版本保持原文件名，例如
`groupStory_1103_trimmed.mp4`；英文字幕版本会增加 `_en` 后缀，例如
`groupStory_1103_en_trimmed.mp4`，不会覆盖中文字幕版本。

### 8. 验证成品

```bash
ffprobe -v error \
  -show_entries format=duration,size:stream=codec_name,codec_type,width,height \
  -of json \
  scripts/record-story/videos/groupStory_1103_trimmed.mp4

ffmpeg -v error \
  -i scripts/record-story/videos/groupStory_1103_trimmed.mp4 \
  -f null -

git diff --check
```

人工抽查开头、结尾、场景切换、立绘清除、所有选择页、台词和音画同步。

### 9. 生成发布封面

封面必须交给 LLM agent 逐章通读目标剧情 JSON 后单独设计，不得用统一提示词或
批处理脚本机械生成。先确认主要角色、地点、关系变化、冲突和情绪余韵，再选择一个
缩小后仍能一眼读懂视觉重点的创意。每个剧情 ID 生成一张封面，中英文视频可以
共用；封面不是剧情截图，目标是提高点击吸引力，同时保持角色可辨识度。

封面允许带有明显二创和适度“封面欺诈”属性，不要求画面在剧情中真实发生。可以
夸张角色身份、关系、动作、场面和光影，例如把执着追逐的角色设计成压迫感强的
反派 Boss，或把传闻实体化成超现实危机。但不能把所有章节都做成战斗、亢奋或
Boss 对决；同一批封面应主动轮换以下方向：

- **夸张剧情封面**：提取剧情关系或传闻，将其升级为高冲突、高概念的二创画面；
- **抒情封面**：选择误会解除、角色独自离开、关系产生距离等余韵时刻，通过背影、
  步态、长阴影、冷暖分离、天气和负空间表达情绪，不依赖夸张哭泣；
- **彩蛋封面**：剧情平淡或找不到有力场景时，只选一名核心角色制作可爱主题图。
  可以换装、安排反差动作或加入不完全符合原角色性格的趣味设定，二创属性可以更强；
- **象征性封面**：用倒影、影子、旧照片或超现实物件表达角色的过去与现在，但必须
  让观众明确这是同一人的象征，不能看成重复人物或克隆错误。

选择方向时先问“这一批还缺哪一种情绪”，不要默认强刺激一定比安静画面更有吸引力。
角色关系发生变化后的低落、释然、尴尬和孤独，同样可以成为高点击率封面。若采用
剧情外创意，应保留至少一个能回扣本章主题的关系、情绪或象征物，避免变成与视频
完全无关的随机美图。

角色参考图位于：

```text
.local-files/ba-characters/<角色名>/设定集.png
.local-files/ba-characters/<角色名>/回忆大厅.png
```

优先提供 `设定集.png` 约束角色身份、发型、服装和配饰；只有需要补充氛围、表情
或细节时再加入 `回忆大厅.png`。不要提供旧版立绘作为构图参考：参考图只用于保持
角色可辨识度，最终画面应根据剧情重新设计镜头、动作、背景、光影和表情。参考图
并非越多越好，通常每名核心角色一张清晰设定图即可，避免模型混淆人物特征。
换装或设计反差动作时，仍须准确保留发型、瞳色、光环和标志性配饰；服装可以二创，
角色身份锚点不能一起丢失。抒情或彩蛋封面通常优先只提供一名核心角色的设定图，
只有构图确实需要第二名角色时才增加参考图。

使用 `image-generator` skill 对应的参考图生图脚本。脚本位于该 skill 目录根部：

```text
generate_image.py
```

先进入 `image-generator` skill 目录，再运行脚本。下面的 `<项目目录>` 指
`apps/blue-archive-story-viewer`，执行前确保其中的 `.local-files/covers/` 已创建：

```bash
cd <image-generator skill 目录>

uv run generate_image.py \
  "<完整封面提示词>" \
  <项目目录>/.local-files/ba-characters/<角色名>/设定集.png \
  -o <项目目录>/.local-files/covers/<story-id>-cover.jpg \
  -r 2K \
  -a 16:9
```

提示词建议用英文写成一个完整的美术需求，至少包含以下内容：

- 用一句话描述剧情画面、角色动作和相互关系，而不是只罗列人物姓名；
- 明确 `cinematic anime key visual`、`16:9 video thumbnail` 和视觉焦点；
- 指定前景、中景、背景的位置，以及镜头距离、视角和运动方向；
- 写清表情、情绪、时间、天气、光源、主色和氛围；
- 要求准确保留参考图中的发型、瞳色、服装和标志性配饰，但重新设计姿势与构图；
- 为视频标题预留一侧相对干净的负空间，主体避开画面边缘和播放器裁切区；
- 明确 `no text, no logo, no watermark, no UI, no speech bubble`，标题后期添加；
- 限制错误肢体、重复人物、串角色服装等常见问题，并写明每名角色只出现一次。

提示词应明确封面的创意类型和情绪强度。夸张剧情封面要写清谁主导画面、谁处于
被压迫或反应位置，避免只堆叠特效；抒情封面要写清角色为何独处、身体语言和环境
如何表现余韵；彩蛋封面要写清换装主题、反差动作和可爱视觉钩子，而不是只要求
“生成一张角色美图”。倒影或影子构图必须明确 `the reflection/shadow is a symbolic
version of the same person, not a second physical character`。

首轮用 `1K` 或 `2K` 快速验证人物、构图和剧情表达，确认方向后再生成 `2K` 或
`4K` 成品。不要只看画面是否漂亮，还要检查缩小到视频列表尺寸后，主角、动作和
情绪是否仍能一眼辨认。常见返工应一次只改一个重点，例如先修人物身份，再修动作，
最后调整背景和留字空间；笼统要求“更好看”通常不如指出具体问题稳定。

生成经验和常见返工点：

- “预留标题空间”容易被模型画成纯黑矩形或明显的版式占位块。应要求自然形成的
  天空、墙面、景深或光影负空间，并明确 `no blank title panel, no black rectangle`；
- 笔记本、挑战书、路牌、校门、胸牌和包装容易出现伪文字。非必要时移除这些物件；
  必须保留时让内容完全不可见、背向镜头或只作为极小装饰，并检查原尺寸；
- 夸张场面中的雷电、巨影和光效不能盖住角色发型、光环和表情，否则缩略图只剩
  特效而失去角色卖点；
- 多角色构图先检查人数，再检查服装是否串位。每个角色只出现一次，背景剪影也要
  计入人数；
- 抒情封面不要只靠眼泪表达情绪。背影、肩膀姿态、人物间距离、行走方向、天气和
  冷暖光通常更克制，也更有电影感；
- 彩蛋封面允许换装和性格反差，但应至少保留发型、瞳色、光环、标志性配饰中的
  多个身份锚点，避免只剩“相似发色的原创角色”；
- 每轮重做只针对一个明确失败点，例如伪文字、角色身份、重复人物或情绪不对。
  生成后同时检查原图和缩略图，不以文件生成成功代替视觉验收。

成品保存在 `.local-files/covers/`，该目录不进 Git。发布前人工检查角色数量与身份、
手部和武器结构、服装细节、背景透视、意外文字，以及画面四周是否留有安全裁切空间。

## 三、常见问题

| 问题 | 调整方式 |
| --- | --- |
| 找不到 `GroupId` | 确认 `--schema` 指向解码后的 `ScenarioScriptDBSchema.json`，并核对游戏数据版本 |
| 原始行数不对 | 检查下载器导出是否完成，不要用旧版 viewer JSON 反推原始行 |
| 立绘不出现或不消失 | 先检查对应原始 `ScriptKr`；原始帧存在则修播放器，原始帧缺失才考虑精确人工规则 |
| 背景、音效或等待丢失 | 修 `import-ba-raw-story.mjs` 的通用字段保留逻辑，不要逐行补最终 JSON |
| 已存在剧情是否会被导入器修改 | 不加 `--force` 不会；导入器也不会读取它作为参考 |
| 强制重建后旧翻译和配音是否保留 | 不会；`--force` 完全以原始 Table 重建，需要重新走翻译、配音稿和 TTS 流程 |
| 重建后想继续 changed-only TTS | 旧 manifest 按旧行号索引，先迁移或重建 manifest，不能直接运行发布脚本 |
| `TextCn` 为空 | 查看导入摘要的 `ba-l10n unmatched`；尝试 `--refresh-ba-l10n`，确认版本差异后再人工补齐 |
| ruby 被 TTS 读出 | `TextJp` 可保留 ruby 供显示；`TextJpVoice` 必须使用规范化文本或人工 override |
| 配音情绪不理想 | 在 `textJpVoiceOverrides` 添加精确覆盖，再跑 changed-only TTS |
| 自动选择错误 | 强制运行 `preselect-options.mjs ... --force` |
| 选择后浮层不消失 | 检查播放器选择动画和 UI 回调，不要绕过 UI 直接发底层选择事件 |
| 录制卡住 | 先用 `--no-headless` 检查选择配置、控制台和语音加载 |

## 四、原理和脚本关系

```text
Blue Archive Global Table
  -> Blue-Archive-Asset-Downloader
  -> sync-ba-story-data.mjs（只下载 ExcelDB、只导出六张剧情表）
  -> ScenarioScriptDBSchema.json
  -> import-ba-raw-story.mjs + ba-l10n 缺失语言补充
  -> public/story/...json
  -> generate-event-story-index.mjs（活动剧情）
  -> enrich-story-with-llm.mjs
  -> voice-zero-tts.mjs
  -> publish-voice-r2.mjs
  -> preselect-options.mjs
  -> run-record.sh
```

- `import-ba-raw-story.mjs`：唯一剧情导入入口。以原始数据库导出为剧情骨架，
  保留所有帧和原始字段，不读取或合并旧 JSON；ba-l10n 只用于补空语言字段。
- `generate-event-story-index.mjs`：根据活动 ID 或剧情 GroupId 生成前端活动
  入口，只收录已导入章节，并从 ba-l10n 补齐活动及章节的多语言标题和简介。
- `sync-ba-story-data.mjs`：独立的数据准备入口。负责精准下载 ExcelDB 并导出
  剧情、活动查询和角色解析所需的六张表，不属于 `process-story`。
- `process-story.mjs`：依次执行原始导入、配音稿生成、TTS 和 R2 发布。
  它要求 `ScenarioScriptDBSchema.json` 已经存在，不负责构建 Docker 镜像、
  下载或更新 Table。
- `enrich-story-with-llm.mjs`：生成或补齐 `TextJpVoice`。
- `voice-zero-tts.mjs`：准备参考音频、生成并下载 MP3，不写公网 URL。
- `COLLECTIVE_VOICE_CONFIG.md`：规定 LLM agent 在 TTS 前检查集体发言和 `???`
  未知说话人、维护逐行配置，并由生成端强制选择真实角色参考音或逐成员混音。
- `publish-voice-r2.mjs`：上传 MP3，并将公网 URL 写入 `VoiceJp`。
- `preselect-options.mjs`：扫描选择页并维护录制预选。
- `shared-config.mjs`：保存人工配音稿、角色词表和录制预选。
- `run-record.sh`：构建播放器、启动 Vite、录像并裁剪 MP4。
- `scripts/record-story/record-story.mjs`：Playwright 录制与音视频封装底层实现。

数据规则稳定且凭据齐全后可以一键处理：

```bash
pnpm process-story 1103 \
  --type group \
  --schema /Volumes/storage/ba-asset-data-global/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json
```

对于尚不存在的剧情，上述命令从 `import-ba-raw-story.mjs` 开始；如果目标 JSON
已经存在且没有传 `--force`，会跳过导入并从 enrichment 开始。`--force` 会连同
enrichment 和 TTS 一起强制重做，因此仅想用 raw 重建旧剧情时，应单独运行
`pnpm import-ba-raw-story ... --force`。
