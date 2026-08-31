# 集体发言与未知说话人 TTS 配置规范

本文档规定 LLM agent 在生成 ZeroTTS 任务前，如何检查剧情中的集体发言和 `???`
未知说话人、如何写入推理配置，以及 TTS 程序应如何读取、验证并选择真实角色参考音。

集体成员不能仅根据说话人名称或当前画面自动决定。场景指令只能提供候选人，最终
`members` 必须由 LLM agent 结合前后剧情、角色槽位、台词语义和译文确认。
`???` 也不能直接降级到通用 NPC 声线。LLM agent 必须提前结合完整剧情推断真实
说话人；只有剧情确实没有给出具名身份时，才可明确标记为匿名角色。

## 强制流程

对每个准备生成 TTS 的剧情，LLM agent 必须按以下顺序执行：

1. 完整读取目标剧情的 `content`，不能只搜索已知的社团名称。
2. 按本文规则逐行检查可能的集体发言以及所有有效 TTS 文本的 `???` 台词。
3. 创建或更新该剧情的审核配置；确认两类特殊台词都不存在时也必须写入
   `lines: []`。
4. 重新读取配置和剧情，执行本文定义的全部一致性检查。
5. 只有配置状态完整且验证通过，才可以运行 ZeroTTS 的 `upload`、`tasks`、
   `poll` 或 `all` 阶段。

如果成员或 `???` 的身份无法可靠确认，必须将该行保留为 `needs-review` 并停止
TTS。不得猜测，也不得通过省略配置将其降级为匿名 NPC 或普通角色。

## 配置位置

配置必须提交到版本库，不能放在 `.local-files`，也不能写进可能被重新导入覆盖的剧情
JSON。配置路径镜像目标剧情在 `public/story` 下的相对路径：

```text
剧情：public/story/event/10014/10014030.json
配置：tools/create-story/config/collective-voices/event/10014/10014030.json

剧情：public/story/group/1102/1102.json
配置：tools/create-story/config/collective-voices/group/1102/1102.json

剧情：public/story/other/400.json
配置：tools/create-story/config/collective-voices/other/400.json
```

不要建立全局 `groups.json`。每条台词的 `members` 是唯一可信的实际参与名单；同一
社团在不同场景中可能只有部分成员发言。

## 配置格式

每个剧情配置使用以下 JSON 结构：

```json
{
  "schemaVersion": 2,
  "source": {
    "storyPath": "public/story/event/10014/10014030.json",
    "contentLength": 105,
    "scanDigest": "sha256:<digest>"
  },
  "lines": [
    {
      "storyIndex": 104,
      "kind": "collective",
      "status": "ready",
      "expected": {
        "speaker": "방과후 디저트부",
        "scriptKr": "#na;방과후 디저트부;어어어어어엉-!?!?\n#fontsize;100",
        "ttsText": "[screaming][shocked]ええええええー！？"
      },
      "members": [
        "요시미",
        "아이리",
        "나츠"
      ]
    }
  ]
}
```

字段要求：

- `schemaVersion`：当前固定为 `2`；读取端遇到其他版本必须停止。
- `source.storyPath`：相对于应用目录的正式剧情路径，必须与配置的镜像路径一致。
- `source.contentLength`：检查配置时的 `story.content.length`。
- `source.scanDigest`：本文后述的剧情检查摘要，用于发现新增、删除或修改的台词。
- `lines`：按 `storyIndex` 升序排列；没有集体发言和未知说话人时必须为空数组。
- `storyIndex`：`story.content` 的零基数组下标，不是剧情中的 `GroupId`。
- `kind`：只能是 `collective` 或 `unknown-speaker`，用于明确覆盖自动分类。
- `status`：只能是 `ready` 或 `needs-review`；TTS 只接受 `ready`。
- `expected.speaker`：从 `ScriptKr` 解析出的原始韩文说话人，必须完整保留空格。
- `expected.scriptKr`：该行完整、未经规范化的 `ScriptKr`。
- `expected.ttsText`：该行实际提交给 ZeroTTS 的文本。
- `members`：仅用于 `collective`；填写实际共同发言的角色说话人列表，使用剧情中的
  韩文角色键。

`kind: "unknown-speaker"` 还要求：

- 原始 `expected.speaker` 可以是由两个以上问号组成的未知说话人，也可以是说话人例外确认
  没有角色语音资源、必须人工覆盖的说话人标签（例如观光客 A）。
- `resolution: "character"` 表示已推断为具名角色；`resolvedSpeaker` 必须填写该角色
  在剧情和角色目录中使用的韩文键，TTS 使用该角色的真实参考音。
- `resolution: "anonymous"` 表示完整剧情只能确认到太妹 A、学生 A 等匿名身份；
  `resolvedSpeaker` 填写确认后的匿名键，TTS 才允许使用通用 NPC 参考音和后处理。
- `evidence` 必须简洁记录推断依据，例如后续立绘揭示、自报姓名、连续台词、其他
  角色的称呼或舞台槽位。不能只写“看起来像”或重复 `resolvedSpeaker`。

所有带有效 TTS 文本的 `???` 行都必须出现在配置中。遗漏任何一行，读取端必须在
上传参考音和创建任务前报错。

实际的未知说话人配置项示例：

```json
{
  "storyIndex": 75,
  "kind": "unknown-speaker",
  "status": "ready",
  "expected": {
    "speaker": "???",
    "scriptKr": "#na;???;……아. 선생님. 여깁니다.",
    "ttsText": "[gentle]……あ、先生。こちらです。"
  },
  "resolution": "character",
  "resolvedSpeaker": "스즈미",
  "evidence": "Suzumi appears immediately afterward and continues addressing Sensei."
}
```

`members` 至少包含两个不同角色。顺序采用该场景中角色首次进入最后一组有效舞台
状态的顺序；顺序不会改变混音语义，但必须稳定，以保证 manifest 和摘要可复现。

不确定时可以记录调查结果，但不能标记为 `ready`：

```json
{
  "storyIndex": 104,
  "kind": "collective",
  "status": "needs-review",
  "expected": {
    "speaker": "방과후 디저트부",
    "scriptKr": "#na;방과후 디저트부;어어어어어엉-!?!?\n#fontsize;100",
    "ttsText": "[screaming][shocked]ええええええー！？"
  },
  "suggestedMembers": ["요시미", "아이리", "나츠"],
  "members": []
}
```

`suggestedMembers` 仅供复核，读取端不得用它生成 TTS。

## 实际 TTS 文本

`expected.ttsText` 必须与 `voice-zero-tts.mjs` 的文本选择规则完全一致：

1. 如果该行存在 `TextJpVoice` 属性，即使值为空字符串，也使用其 trim 后的值。
2. 只有 `TextJpVoice` 属性不存在或值为 `null` 时，才回退到 trim 后的 `TextJp`。
3. 实际文本为空时不创建 TTS；如果该行被配置为集体发言，配置验证应报错并要求
   LLM agent 判断该配置是否应删除。

不要把 `TextCn`、`TextEn` 或 `VoiceJp` 写入 `expected`。这些字段不会决定日语
TTS 内容，翻译或发布 URL 的变化不应使配置失效。

## scanDigest 算法

`scanDigest` 只覆盖可能影响集体发言识别和 TTS 内容的字段，不能直接对整个剧情
文件计算哈希，因为发布阶段会修改 `VoiceJp`。

读取全部 `story.content`，为每一行生成以下二元素数组：

```js
[
  String(unit.ScriptKr ?? ""),
  unit.TextJpVoice !== undefined && unit.TextJpVoice !== null
    ? String(unit.TextJpVoice).trim()
    : String(unit.TextJp ?? "").trim(),
]
```

按原顺序组成数组，对 `JSON.stringify(result)` 的 UTF-8 字节计算 SHA-256，最终写成
`sha256:<小写十六进制摘要>`。生成端和读取端必须使用完全相同的算法。

任何 `contentLength` 或 `scanDigest` 不匹配都说明剧情在上次检查后发生了变化。此时
必须重新扫描完整剧情并更新配置，不能只修改摘要。

## LLM agent 如何识别集体发言和未知说话人

`#na;说话人;台词` 不是集体发言的充分条件。匿名 NPC、具名角色和集体都可能使用
`#na`。LLM agent 应对每条有效 TTS 台词依次判断：

1. 从 `ScriptKr` 中解析最终实际说出台词的说话人。
2. 检查说话人是否表示组织、社团、全体成员、人群或多人共同回应。
3. 阅读至少该行前后的完整对话段落，不能只读取相邻一行。
4. 跟踪 `1` 到 `5` 号角色槽位以及 `#all;hide`、特写、反应和退场指令。
5. 结合 `TextJp`、`TextCn`、`TextEn` 和剧情语义判断共同说话的人。
6. 将舞台状态作为候选证据，而不是唯一依据；隐藏、场外或未显示的角色仍可能发言。

集体发言判断结果：

- 明确由两个以上具体角色共同说出：写入 `kind: collective` 配置。
- 学生 A、太妹 A、市民等已经明确为匿名身份的说话人：属于匿名 NPC，不写配置。
- 能解析到单个具体角色：属于普通角色，不写集体配置。
- 疑似集体但成员不确定：写入 `needs-review` 并停止 TTS。

配置是分类的最高优先级。某行存在验证通过的 `kind: collective` 配置时，不能再对
它应用匿名 NPC 音色或 NPC 电音后处理。

对每条 `???` 台词，LLM agent 必须另外执行：

1. 阅读该句所在场景直到身份揭示或场景结束，并在需要时回看前一场剧情。
2. 优先使用强证据：同一句舞台槽位预置角色、紧接着出现并延续对话、自报姓名、
   被其他角色点名、独有称号或连续语气。
3. 能落实到具名角色时写 `resolution: "character"`，不得因当下隐藏立绘而用 NPC 声线。
4. 只能落实到太妹 A 等匿名身份时写 `resolution: "anonymous"`，并说明为何不存在
   可用的具名角色身份。
5. 仍有两个以上合理候选时写 `needs-review`；读取端不得使用候选值生成。

## 当前甜点部样例

`event/10014/10014030.json` 的 `content[104]`：

- 集体说话人：`방과후 디저트부`
- 成员：`요시미`、`아이리`、`나츠`
- 依据：前面最后一组有效舞台状态中是这三人，随后三人依次特写并共同惊叫；和纱
  不在这个场景的发言成员中。

`event/10014/10014075.json` 的 `content[119]`：

- 集体说话人：`방과후 디저트부`
- 成员：`요시미`、`나츠`、`카즈사`、`아이리`
- 依据：共同欢呼前的舞台状态和反应指令明确包含四人。紧邻的 `#all;hide` 只隐藏
  立绘，不能据此把成员列表清空。

这两个例子说明不能为“甜点部”固定一份全员名单，必须逐条配置。

## 读取和验证要求

TTS 程序读取配置时必须先完成全部校验，再上传参考音或创建远程任务：

1. 按目标剧情路径解析唯一的镜像配置路径。
2. 要求配置文件存在，包括确认没有集体发言和 `???` 台词的 `lines: []` 配置。
3. 校验 JSON 结构、`schemaVersion`、镜像路径、`contentLength` 和 `scanDigest`。
4. 拒绝重复或越界的 `storyIndex`，并要求 `lines` 严格升序。
5. 对每项重新解析剧情说话人和实际 TTS 文本，与三个 `expected` 字段精确比较。
6. 拒绝任何 `needs-review`、少于两个集体成员、重复成员、空成员名称，或缺少
   `resolution`、`resolvedSpeaker`、`evidence` 的未知说话人配置。
7. 扫描全部有效 TTS 行，确保每个 `???` 都有且只有一项 `unknown-speaker` 配置。
8. 使用现有角色目录解析流程验证每位集体成员及每个已解析具名角色都有可用参考音。
9. 所有配置一次性通过后，才进入 ZeroTTS 阶段。

不得把配置错误记录为普通警告后继续，也不得静默跳过集体台词。这样可以避免已经
为其他台词创建付费任务后，才发现集体配置不完整。

未知说话人的 `resolvedSpeaker` 或 `resolution` 发生变化时，即使 TTS 文本没有变化，
`--changed-only` 也必须把该行视为已变更并重新生成。`--missing-only` 只补空的
`VoiceJp`，不会覆盖已经发布的旧 NPC 语音，因此修正身份后应使用 `--changed-only`。

## 逐人生成与 manifest

每条集体台词是一个剧情任务，内部包含多个成员任务。所有成员使用完全相同的
`expected.ttsText`，但分别使用各自的 ZeroTTS `referenceId`。不要先把成员参考音
混合成一个参考声音再克隆。

manifest 建议保持剧情行作为顶层键，以兼容发布流程：

```json
{
  "tasks": {
    "104": {
      "kind": "collective",
      "speaker": "방과후 디저트부",
      "text": "[screaming][shocked]ええええええー！？",
      "members": {
        "요시미": {
          "referenceId": "...",
          "taskId": "...",
          "audioPath": ".../collective/0104/요시미.mp3"
        },
        "아이리": {
          "referenceId": "...",
          "taskId": "...",
          "audioPath": ".../collective/0104/아이리.mp3"
        },
        "나츠": {
          "referenceId": "...",
          "taskId": "...",
          "audioPath": ".../collective/0104/나츠.mp3"
        }
      },
      "mix": {
        "version": "collective-v1",
        "inputsHash": "...",
        "audioPath": ".../lines/0104.mp3"
      },
      "audioPath": ".../lines/0104.mp3"
    }
  }
}
```

只有全部成员任务成功并下载后才能混音。任一成员失败时，整个剧情行保持未完成，
不能发布部分成员音频。

默认同时从开头对齐各轨并进行最终响度归一化。以后如需对单条台词调整延迟或增益，
可以在行配置中增加可选覆盖：

```json
"mix": {
  "memberOverrides": {
    "요시미": { "delayMs": 0, "gainDb": 0 },
    "아이리": { "delayMs": 20, "gainDb": -1 }
  }
}
```

没有覆盖时 `delayMs` 和 `gainDb` 均为 `0`。读取端必须拒绝不在 `members` 中的
覆盖键。

成员音频和最终混音的复用键必须包含：实际 TTS 文本、有序成员列表、各成员
`referenceId`、成员任务对应的已下载文本、混音覆盖参数和混音算法版本。只有混音
参数或算法版本改变时，应复用已经下载的成员音频，仅重新混音；成员、文本或对应
参考音变化时，只重新生成受影响的成员任务。

最终只有混音后的 `tasks[index].audioPath` 可以交给 `publish-voice-r2.mjs` 并写入
剧情的 `VoiceJp`。成员中间音频只保存在 `.local-files`，不得单独发布。集体音频也
不得应用匿名 NPC 的电音效果。
