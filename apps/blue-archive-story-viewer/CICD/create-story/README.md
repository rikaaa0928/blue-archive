
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

## 从 ba-l10n 导入日文剧情

`import-ba-l10n-story.mjs`: 从 `ba-l10n.cnfast.top` 的剧情数据接口下载指定章节，并转换成本项目播放器使用的 `public/story/<type>/<id>.json` 格式。

默认只导入日文文本到 `TextJp`，并保留源数据里的 `Script` 到 `ScriptKr`，用于播放器解析角色、表情、标题、选项等脚本信息。`VoiceJp` 暂时留空。

示例：

```bash
pnpm import-ba-l10n-story 1101 --force
```

等价于下载：

```text
https://ba-l10n.cnfast.top/data/story/normal/1101.json
```

并生成：

```text
public/story/main/1101.json
```

也可以传 ba-l10n 的页面 URL：

```bash
pnpm import-ba-l10n-story https://ba-l10n-aws.cnfast.top/scenario/1101 --force
```

常用参数：

- `--type <main|other|favor|event|group|mini>`：输出剧情类型，默认 `main`
- `--out-id <id>`：输出剧情 ID，默认使用源章节 ID
- `--directory-id <id>`：输出到 `favor/event/group/mini` 这类分目录剧情时指定目录 ID
- `--input <file>`：从本地 ba-l10n JSON 文件转换，不联网
- `--dry-run`：只打印转换统计，不写文件
- `--force`：覆盖已存在的输出文件

## 自动翻译和生成日语配音情绪稿

`enrich-story-with-llm.mjs`: 调用 Vertex Gemini，为已导入的剧情补齐：

- `TextCn`：简体中文本地化文本
- `TextJpVoice`：基于原始 `TextJp` 插入情绪 tag 的日语配音稿

脚本会把剧情标题、地点、角色表、全局剧情大纲、目标行前后文、脚本 cue、音效和 BGM 一起提供给 LLM，避免只按单句翻译或标注。

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
- `--force`：重做已经存在 `TextCn` 和 `TextJpVoice` 的行
- `--output <file>`：写入另一个 JSON 文件，默认覆盖源文件

## 本地语音文件临时服务

开发环境下，Vite 会把项目内 `.local-files` 目录通过 `/api/local-files/` 暴露出来，用于临时播放本地生成的 TTS 音频。

示例：

```text
.local-files/tts/group/1101/0006.mp3
```

对应可访问 URL：

```text
/api/local-files/tts/group/1101/0006.mp3
```

剧情 JSON 里的 `VoiceJp` 可以直接写这个 URL。播放器遇到以 `/` 或 `http(s)://` 开头的 `VoiceJp` 时会直接播放，不再拼接官方 CDN 的 `Audio/VoiceJp` 路径。

默认文件根目录是：

```text
apps/blue-archive-story-viewer/.local-files
```

也可以用环境变量覆盖：

```bash
BA_LOCAL_FILE_ROOT=/path/to/generated/files pnpm dev
```

## ZeroTTS 语音生成流水线

`voice-zero-tts.mjs`: 读取剧情 JSON 的 `TextJpVoice`，按角色准备参考音频，并调用 ZeroTTS 生成每句日语语音。

脚本分阶段执行，所有中间状态保存在 `.local-files/tts/<type>/<storyId>/voice-zero-tts-manifest.json`，可以中断后继续。

参考音频来源默认使用：

```text
/Users/rikaaa0928/src/yling/ai/skill/ba-video-generator-v3/ba-downloader/output
```

下载器暂时不重写，脚本只复用已有 Python 下载器的输出。若缺少某个角色，可以加 `--download-missing` 调用现有下载器补齐：

```bash
pnpm voice-zero-tts 1101 --type group --stage prepare --download-missing
```

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

下载完成后，脚本会把每句生成音频写到：

```text
.local-files/tts/group/1101/lines/0006.mp3
```

并把对应剧情行的 `VoiceJp` 写成：

```text
/api/local-files/tts/group/1101/lines/0006.mp3
```

常用参数：

- `--stage <prepare|upload|tasks|poll|all>`：执行阶段，默认 `prepare`
- `--limit <n>`：只处理前 n 句，用于小样本测试
- `--force`：重建参考音频、重建任务或覆盖已下载音频
- `--model <model>`：ZeroTTS 模型，默认 `zerotts-v1`
- `--speaker-map <file>`：覆盖脚本角色名到下载器角色目录名的映射
- `--download-missing`：缺少角色语音目录时调用现有 Python 下载器
- `--reference-min <n>`：每个角色参考音频最低总秒数，默认 `20`
- `--reference-max <n>`：每个角色参考音频最高总秒数，默认 `60`
- `--reference-min-clip <n>`：单条参考音频最低秒数，默认 `5`
- `--reference-gap <n>`：参考片段拼接间隔秒数，默认 `0.8`

## 发布语音到 Cloudflare R2

`publish-voice-r2.mjs`: 本地生成 ZeroTTS 音频后，把剧情 JSON 中的 `/api/local-files/...` 语音上传到 R2，并把 `VoiceJp` 改写成 R2 公网 URL。

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
