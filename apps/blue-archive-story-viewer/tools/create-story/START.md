# 剧情制作快速入口

完整流程、产物边界和失效规则只维护在
[`INDEPENDENT_TRACK_WORKFLOW.md`](./INDEPENDENT_TRACK_WORKFLOW.md)。本文件仅保留环境准备与启动方式。

## 一次性环境准备

在仓库根目录执行：

```bash
CYPRESS_INSTALL_BINARY=0 node common/scripts/install-run-rush.js update
pnpm -C lib/ba-story-player build
```

应用或仓库 `.env` 至少配置原始表路径；实际执行相应功能时，再配置 Vertex、ZeroTTS、R2
凭据。密钥不要写入 `.local-files` 或提交到仓库。

```dotenv
BA_SCENARIO_SCHEMA_PATH=/path/to/ScenarioScriptDBSchema.json
GOOGLE_CLOUD_PROJECT=your-project
GOOGLE_CLOUD_LOCATION=us-central1
ZERO_TTS_API_KEY=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=...
R2_PUBLIC_BASE_URL=https://assets.example.com
```

如果需要由工具下载原始表，首次还要构建下载器镜像：

```bash
docker build -t ba-asset-downloader:v2.3.0 \
  apps/blue-archive-story-viewer/tools/create-story/docker
```

## 启动工作台

```bash
pnpm -C apps/blue-archive-story-viewer story-workbench
```

浏览器打开 `http://127.0.0.1:4178`。工作台只接受 localhost 连接。活动和主线都可以批量选择
全部或部分片段；默认“一键完成”会采用生成结果和默认 NPC，保留已选分支，仅为空缺页面补
第一个选项，并录制到完整性验收，
也可只推进到人工审核后再继续。简中默认使用 `gemini-3.1-pro-preview`，语音情感标注默认使用
`gemini-3.7-flash`。若 `public/story` 已有同一剧情，工作台会先验证原始结构，再继承已完成的
字幕、配音稿和语音。

工作台会在模型调用、资源下载、ZeroTTS、R2、正式剧情文件生成和视频录制等有成本或有外部
影响的操作前确认。流程不包含任何视频发布步骤。

本地数据目录和清理边界见 [`README.md`](./README.md)。
