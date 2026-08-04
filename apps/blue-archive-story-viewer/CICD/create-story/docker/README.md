# Blue Archive 剧情 Table 下载容器

本目录把
[`ZM-Kimu/Blue-Archive-Asset-Downloader`](https://github.com/ZM-Kimu/Blue-Archive-Asset-Downloader)
固定在 `v2.3.0`，封装成 Linux/arm64 可运行的 Docker 镜像。默认剧情工作流使用
国际服（`gl`）数据。

剧情流水线继续默认使用 GL，而不是 JP：精准模式下两者都只处理 ExcelDB，但
GL catalog 可直接获取，并且同一张剧情表已经包含官方日文、繁中、英文和泰文；
JP 需要额外的客户端 bootstrap，导入后也要从外部补更多语言。综合下载、处理和
翻译补全次数，GL 的总压力更小。

## 推荐操作

在仓库根目录构建镜像：

```bash
docker build \
  -t ba-asset-downloader:v2.3.0 \
  apps/blue-archive-story-viewer/CICD/create-story/docker
```

然后进入应用目录，运行项目封装：

```bash
cd apps/blue-archive-story-viewer
pnpm sync-ba-story-data
```

默认数据目录来自：

1. `BA_ASSET_DATA_DIR`；
2. `BA_SCENARIO_SCHEMA_PATH` 向上推导的数据根目录；
3. `/Volumes/storage/ba-asset-data-global`。

常用参数：

```bash
pnpm sync-ba-story-data \
  --data-dir /absolute/path/ba-asset-data-global \
  --image ba-asset-downloader:v2.3.0 \
  --region gl \
  --threads 4
```

已经存在 `raw/Table/ExcelDB.db` 时，只重新生成目标 JSON：

```bash
pnpm sync-ba-story-data --skip-download
```

完成后的主文件为：

```text
<data-dir>/extracted/Table/ExcelDB/ScenarioScriptDBSchema.json
```

## 精准下载与提取设计

不要使用下面这种全量 Table 同步作为日常剧情更新方式：

```bash
ba-downloader sync --region gl --resource-type table
```

GL catalog 中的 `table` 不只是 Excel 数据库，还包含数千个战斗地图、Raid、
Ground 和测试关卡 ZIP。全量同步会下载、并发解析这些与剧情 JSON 无关的文件。

项目封装把流程拆成两步。

### 1. 只下载 ExcelDB

`sync-ba-story-data.mjs` 调用上游：

```bash
ba-downloader download \
  --region gl \
  --resource-type table \
  --search ExcelDB
```

上游的 `ResourceQueryService.search_name()` 在下载前按 catalog 资源路径过滤。
因此真正进入下载器的 Table 资源只有 `ExcelDB.db`，不会下载整个 Table catalog
的 payload。

### 2. 只导出剧情所需数据库表

上游原生：

```bash
ba-downloader extract --region gl --resource-type table --search ExcelDB
```

虽然只读取一个数据库，却会导出 ExcelDB 中的全部表。项目内的
`extract-story-tables.py` 复用上游已固定版本的以下能力：

- GL/JP runtime package 和 IL2CPP schema 准备；
- GL/JP SQLCipher key provider；
- SQLCipher 页级 HMAC 校验和解密；
- FlatBuffer/MemoryPack 数据解析；
- `TableExtractor.process_db_file(..., table_name=...)` 的单表读取。

工具只导出：

```text
ScenarioScriptDBSchema.json
EventContentScenarioDBSchema.json
EventContentSeasonDBSchema.json
LocalizeDBSchema.json
LocalizeEtcDBSchema.json
ScenarioCharacterNameDBSchema.json
```

它们分别提供完整剧情帧、活动与 GroupId 关系、活动/复刻元数据、常规本地化文本
、补充本地化文本和角色脚本哈希/多语言显示名。剧情导入、活动查询及角色解析
不需要其余 ExcelDB 表。

每张 JSON 先写入 `.json.tmp`，完成后再原子替换正式文件，避免中断时留下半个
JSON。

## 首次运行和缓存

第一次在全新数据目录运行时仍需要下载当前 GL XAPK。原因不是提取剧情资源本身，
而是上游必须从客户端 IL2CPP 元数据生成与当前版本匹配的
`FlatBufferData`/`MemoryPackData` schema。

后续运行会复用：

```text
raw/Table/ExcelDB.db
temp/<客户端版本>/Runtime/
extracted/Dumps/
extracted/FlatBufferData/
extracted/MemoryPackData/
```

因此通常只需更新 ExcelDB 并重新导出六张表。`--skip-download` 完全跳过 catalog
资源下载，但 SQLCipher key 获取和必要的 schema 准备仍可能联网。
`temp/SQLCipher/` 是本次运行生成的明文临时数据库位置，不视为跨运行缓存。

## 密钥和安全边界

- GL SQLCipher key 由上游 `GlSqlCipherKeyProvider` 获取。
- 工具不打印、不保存 key。
- 解密后的临时 SQLite 可能位于 `<data-dir>/temp/SQLCipher/`。
- `raw`、`temp`、`extracted` 和其中的数据库均不得提交进 Git。
- `--sqlcipher-key-hex` 没有暴露在项目封装中；如需离线覆盖，应先评估密钥保存
  风险，再扩展命令。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 构建固定上游版本和运行环境，并把精准提取工具装入镜像 |
| `extract-story-tables.py` | 复用上游内部接口，只导出六张剧情相关表 |
| `../sync-ba-story-data.mjs` | 宿主机入口，编排精准下载、容器提取和产物检查 |

## 上游升级注意事项

`extract-story-tables.py` 使用了上游 Python 内部 API，而不是稳定 CLI，因此
`Dockerfile` 必须固定 `UPSTREAM_REF`。升级上游版本时至少验证：

1. `AppSettings` 和 region profile 构造仍兼容；
2. `TableExtractor.from_context()` 与 `process_db_file(table_name=...)` 仍存在；
3. GL SQLCipher resolver 仍由 table profile 注入；
4. 六张 JSON 均可完整解析；
5. `find-event-story` 名称查询、活动 ID 查询和 GroupId 反查正常；
6. `import-ba-raw-story --dry-run` 能读取新 `ScenarioScriptDBSchema.json`。

如果这些内部 API 发生变化，优先给上游贡献“按数据库表名导出”的正式 CLI
参数；不要在项目内重新实现 SQLCipher 或 MemoryPack 协议。

## 当前版本验证记录

验证环境：`v2.3.0` 镜像、GL 客户端 `1.90.439170`、Linux/arm64。

| 方式 | 导出范围 | 耗时 | 产物大小 |
| --- | ---: | ---: | ---: |
| 上游原生 `extract --search ExcelDB` | ExcelDB 全部 408 张表 | 约 293 秒 | 约 689 MiB |
| 项目精准提取，复用已生成 schema | 上述 5 张表 | 约 99 秒 | 约 275 MiB |

精准产物均通过 JSON 解析；五个文件与上游全量提取的对应文件内容逐字节一致，
仅项目工具统一补了末尾换行。包含解析 schema 的完整精准输出目录约 388 MiB。

此前验证过 GL catalog 的全量 `table` 同步会选中 6,237 个原始文件，并处理大量
无关 ZIP；它不是剧情更新的必要步骤。当前封装的下载阶段在 catalog 过滤后只把
`ExcelDB.db` 交给下载器。
