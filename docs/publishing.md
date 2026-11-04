# 发布与安装

## 安装

有两条路。新装优先选路 A。

### 路 A（推荐，当前真实可用）

1. 把仓库放到固定位置，确认入口文件存在：`<你的工作区>/dsh-supergroup/src/plugin2.mjs`。
2. 打开 `~/.dsh/profiles/<profile>/cordis.patch.yml`，在**文件末尾追加**：

```yaml
- insert:
    - id: dsh-supergroup
      name: file:///<你的工作区>/dsh-supergroup/src/plugin2.mjs
      config:
        registryFile: '<你的 DSH_HOME>\data\registry.json'
        groupsFile: '<你的 DSH_HOME>\data\groups.json'
        ledgerFile: '<你的 DSH_HOME>\data\tasks.jsonl'
```

3. `name` 必须是**绝对路径**的 `file:///` 形式，并指向**入口文件**；不是目录。Windows 路径把反斜杠写成 `/`。
4. 重启宿主（或重新加载 profile）。侧栏应出现「超级代理部署」图标，`ms2_status` 应可用。

### 路 B（bundle）

bundle 安装要求以下三件事同时成立：

1. profile 的 `package.json` 在 `dependencies` 里登记本包，例如 `"dsh-supergroup": "file:<你的工作区>/dsh-supergroup"`；
2. 同一个 `package.json` 的 `dsh.profile.bundles` 数组包含 `"dsh-supergroup"`；
3. 在 profile 目录执行 `pnpm install`，让包真正进入 `node_modules`。

三者齐备后，bundle 会读取包内的 `cordis.patch.yml`；其中 `name` 使用包名 `dsh-supergroup`，不是 `file://` 路径。

装完没反应时，按 README 的「装完没反应怎么查」用 `dsh --dump-config` 排查。

`client/client.js` 是独立客户端 bundle；仅改客户端代码不会热更，必须重启宿主。

## 文件布局

```text
dsh-supergroup/
├── src/
│   ├── plugin2.mjs        # 插件入口：工具、命令、guard、启动对账
│   └── core/              # 整体、注册表、账本、投递、协调器、权限
├── client/client.js       # 侧栏面板 bundle
├── cordis.patch.yml       # bundle 安装用的 insert 清单
├── tests/                 # 自动化测试（node:test）
├── docs/                  # 使用手册、能力状态、设计说明、本文件
├── README.md
├── LICENSE
└── package.json
```

发布包不包含运行时数据：

- `data/groups.json`
- `data/tasks.jsonl`
- `data/registry.json`
- `data/session-events.log`
- `data/blank-candidates*.csv`
- `data/archive-report-*.jsonl`

这些文件由运行中的插件在配置路径下自行创建。

## 升级

1. 先停止写入（没有正在跑的工单最稳妥）。
2. 备份配置目录下的 `groups.json`、`registry.json`、`tasks.jsonl`。
3. 用新版本覆盖 `src/`、`client/`、`docs/`、`tests/`、`README.md`、`package.json`、`cordis.patch.yml`。
4. 重启宿主。
5. 首次启动时插件会读旧账本并做一次恢复对账；`uncertain` 工单可能需要一次 `ms2_status` 才会收敛。

账本只追加，不重写历史；升级不会主动删除账本行。

## 删除干净

1. 从 profile 的 `insert` 条目中删除该条目；若用 bundle 安装，同时从 `dependencies` 与 `dsh.profile.bundles` 移除，并重新 `pnpm install`。
2. 重启宿主。
3. 删除仓库目录。
4. 按需删除配置里指定的 `groups.json`、`registry.json`、`tasks.jsonl`、`session-events.log`。

**插件不会删除任何会话。** 删除仓库与数据文件也不会删除 DSH 会话、会话历史或日志分区。如果还要清理会话，请用 DSH 自己的会话管理入口，逐个确认。

## 发布前检查

```bash
node --check src/plugin2.mjs
node --check client/client.js
node --test tests/*.test.mjs
```

并确认仓库内没有真实会话 UUID、个人目录路径、账号或凭据。示例中的 `session-...`、`<你的 DSH_HOME>`、`<你的工作区>`、`<profile>` 都是占位符。
