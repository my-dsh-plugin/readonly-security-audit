# readonly-security-audit

[English](README.md) | 中文

> ## ⚠️ 实验性项目 —— 请先阅读
>
> 这是只读安全审计模式的**实验性插件实现**，用于尝试「插件层相对纯预设还能
> 多做哪些事情」。日常使用请优先选择**原生模式方案**：纯预设、脚本化安装的
> 版本放在
> [`dsh-presets`](https://github.com/my-dsh-plugin/dsh-presets) 仓库
> （`readonly-audit/` 目录），不依赖任何自定义插件，任意主机一条命令即可安装
> （bash / PowerShell）。详见下文「推荐替代方案」。
>
> ### 插件层额外尝试的能力（本次实验的内容）
>
> 相比原生纯预设版，本插件额外提供：
>
> - **自动只读** —— 进入审计模式时由插件自己将会话沙箱切到 `read-only`，
>   部署无需把 `sandbox-policy` 默认模式配置成 read-only；
> - **工具级白名单门禁** —— 最外层的 `tools/pre-execute` 监听器会拒绝一切
>   非白名单工具调用，而不只是拦截文件写入；
> - **强制报告交付选择** —— 用户未在「对话 / 文件」中选择前，模型不能开始
>   阅读；
> - **会话级斜杠命令** —— `/readonly-audit on|off|status`；
> - **单次批准写入 + 自动恢复** —— 获准的报告写入只把这一次调用临时放宽到
>   `workspace-write`，调用结束后立即恢复 `read-only`。
>
> 这些正是「预设文件本身无法表达」的能力。如果你确实需要它们，再安装本插件；
> 否则优先使用下面的原生方案，更简单、更稳。
>
> ### 推荐替代方案（原生纯预设，脚本式安装）
>
> ```bash
> bash -c "$(curl -fsSL https://raw.githubusercontent.com/my-dsh-plugin/dsh-presets/main/readonly-audit/install-readonly-audit.sh)"
> ```
>
> Windows PowerShell：
>
> ```powershell
> irm https://raw.githubusercontent.com/my-dsh-plugin/dsh-presets/main/readonly-audit/install-readonly-audit.ps1 | iex
> ```
>
> 取舍：原生版**没有自动只读** —— 部署的 `sandbox-policy` 默认模式必须已是
> `read-only`（或会话手动切换），也没有工具级白名单门禁与强制交付选择；但它
> 挂载的一切在强制层依然是完全只读的。

---

DeepSeek Harness 新增的**内置“只读安全审计”模式**。它直接出现在 Agent 预设选择器中，与标准模式、PTC 模式、极简模式、创造模式并列：**只读安全审计 / Read-only audit mode**。该模式下，AI 只能阅读和分析代码、依赖与配置；任何文件写入都由系统强制拦截，只有用户对某一次写入明确批准后才放行。

## 功能

- `readonly-audit` 预设以 `active: true` 启动，新建会话即处于审计模式，不需要先输入命令。
- `/readonly-audit off` 仅为当前会话退出审计模式并恢复进入前的沙箱/审批策略；`/readonly-audit on` 与 `/readonly-audit status` 仍可用。
- 进入模式时写入 `sandbox/mode: read-only`，复用 Harness 自带的文件系统沙箱与进程沙箱。`write`、`edit`、会写文件的 shell 命令都会在系统层被拒绝，而不是只靠模型自觉。
- 插件同时注册最外层的 `tools/pre-execute` 门禁。审计模式下，每个工具调用要么属于只读白名单（`read`、`read_image`、`glob`、`grep`、`str_replace_editor view`、受沙箱保护的 `bash`/`pwsh`、网页读取/搜索、询问类工具），要么是对单次写入的显式批准；其他调用一律以 `[readonly-audit] 只读安全审计模式` 拒绝。
- 审计开始前，模型被强制调用 `choose_audit_report_delivery`，用户二选一：
  - **对话直接回复** —— 报告直接在对话中输出，不创建文件；
  - **生成报告文件** —— 审计结束后 AI 把报告写入 `SECURITY_AUDIT_REPORT.md`。该次写入会单独请求用户批准；批准后仅在这一次调用中临时变为 `workspace-write`，调用结束立刻恢复 `read-only`。
- 报告格式要求每条发现包含：问题描述、严重程度、所在位置、证据、修复建议。修复建议仅文字说明，本模式下 AI 不实际改代码。

## 为什么是“系统强制”而不是提示

1. `readonly-audit/mode` 与 `readonly-audit/delivery` 是持久化会话事件；恢复会话或 fork 时通过日志重放即可还原。
2. 会话 `sandbox/mode` 被置为 `read-only`，由 Harness 现有的 `dsh-fs-sandbox` 和 `dsh-bash-sandbox` 在文件系统与子进程两层强制执行。
3. `tools/pre-execute` 前置监听器在任何工具执行前拦截非只读调用；如果当前 shell 执行器不能强制只读，`bash`/`pwsh` 会被直接拒绝。
4. 批准写入是“一次一批”的：批准后追加 `workspace-write`，`tools/post-execute` 立即追加 `read-only`。审计模式下禁用内置 `sandbox_permissions` 升级通道，报告写入不可能扩大为全量访问。

## 在任意 Harness 检出 / fork / 其他电脑上安装

本插件不绑定某个仓库路径。无论上游 Harness、个人 fork（例如
`deepseek-harness-fork`）、打包安装版，还是另一台机器，流程完全一样。

安装只需要两件事：

1. 把插件包装进目标 profile；
2. 让 `readonly-audit` 预设出现在 Harness 的预设扫描目录中。

目标机器不需要构建，仓库已随附 `lib/` 预构建产物。

### 1. 把插件安装进 profile

通用方式，使用目标 Harness 自己的 `dsh` CLI：

```sh
cd /path/to/your-deepseek-harness

DSH_HOME=/path/to/your-dsh-home \
  node apps/cli/lib/bin.js plugin \
  --profile web \
  add /path/to/readonly-security-audit
```

如果你的 Harness 提供 `pnpm dsh`，等价命令是：

```sh
cd /path/to/your-deepseek-harness

DSH_HOME=/path/to/your-dsh-home \
  pnpm dsh plugin add --profile web /path/to/readonly-security-audit
```

直接 git 安装：

```sh
DSH_HOME=/path/to/your-dsh-home \
  node apps/cli/lib/bin.js plugin \
  --profile web \
  add github:my-dsh-plugin/readonly-security-audit
```

离线 tarball 安装：

```sh
DSH_HOME=/path/to/your-dsh-home \
  node apps/cli/lib/bin.js plugin \
  --profile web \
  add /tmp/dsh-readonly-security-audit-0.1.0.tgz
```

手工等价做法是编辑 profile 的 `package.json`：

```json
"dependencies": {
  "dsh-readonly-security-audit": "link:/path/to/readonly-security-audit"
}
```

```json
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-readonly-security-audit"]
  }
}
```

### 2. 让模式出现在预设选择器中

下面两条路径任选其一，效果等价。

#### 路径 A：目标 Harness 已随附预设目录

如果目标 Harness 已经包含：

```text
apps/cli/config/agent-presets/readonly-audit/
```

则无需安装预设目录。安装插件并重启后，模式会作为内置预设出现。

#### 路径 B：安装到用户可写预设根目录

这种方式不需要修改 fork 或旧版 Harness 的源码：

```sh
cd /path/to/readonly-security-audit

DSH_HOME=/path/to/your-dsh-home \
  node scripts/install-preset.mjs
```

使用默认 `~/.dsh` 时：

```sh
cd /path/to/readonly-security-audit
node scripts/install-preset.mjs
```

检查是否落到正确的 DSH_HOME：

```sh
ls "$DSH_HOME/.agent-presets/readonly-audit"
# agent.cordis.yml
# preset.yml
```

然后完全重启 Harness。

### 示例：用于个人 fork

```sh
# 1. 把插件装进 fork 的 web profile
cd /path/to/deepseek-harness-fork
DSH_HOME=/path/to/fork-dsh-home \
  node apps/cli/lib/bin.js plugin \
  --profile web \
  add /path/to/readonly-security-audit

# 2. 把预设装进同一个 DSH_HOME
cd /path/to/readonly-security-audit
DSH_HOME=/path/to/fork-dsh-home \
  node scripts/install-preset.mjs

# 3. 重启 fork
cd /path/to/deepseek-harness-fork
DSH_HOME=/path/to/fork-dsh-home \
  node apps/cli/lib/bin.js web
```

如果你希望它显示为 fork 的内置预设，可以把预设目录复制进 fork：

```sh
mkdir -p /path/to/deepseek-harness-fork/apps/cli/config/agent-presets/readonly-audit
cp /path/to/readonly-security-audit/presets/readonly-audit/* \
   /path/to/deepseek-harness-fork/apps/cli/config/agent-presets/readonly-audit/
```

### 迁移到另一台电脑

1. 把插件仓库复制或 clone 到新机器，也可以先打包：

   ```sh
   cd readonly-security-audit
   pnpm pack --pack-destination /tmp
   # /tmp/dsh-readonly-security-audit-0.1.0.tgz
   ```

2. 在目标机器执行同样的两步：
   - 把插件安装进目标 profile；
   - 对目标 `DSH_HOME` 执行 `scripts/install-preset.mjs`。
3. 重启并按下面“验证与排障”检查。

唯一的一致性要求是：**插件、预设、Harness 进程必须使用同一个 `DSH_HOME`。**

### DeepSeek Harness Desktop(桌面端)一键安装

桌面端用户无需 checkout:桌面端 harness(由 my-dsh-plugin fork 构建)及其 seed 的 home
已自带 `readonly-audit` 预设。在**普通终端**执行一次(不要在 App 自带的 harness 会话里
跑——那里的应用安装目录和 App 数据目录是沙箱/只读的,macOS 尤其如此):

```sh
bash <(curl -Ls https://raw.githubusercontent.com/my-dsh-plugin/readonly-security-audit/main/scripts/install-desktop.sh) --restart
```

脚本幂等:从 GitHub 拉取插件(预编译 `lib/`,无需构建);装入桌面 web profile 并注册
bundle;`--restart` 重启 App。该插件没有设置命名空间,因此无需白名单补丁。重启后新建
会话,在预设选择器中选择 **只读安全审计 / Read-only audit mode** 即可。
可用环境变量覆盖:`DSH_DESKTOP_APP`、`DSH_DESKTOP_HOME`、`DSH_SKILL_SOURCE_DIR`。

> 使用已发布桌面包的最终用户无需任何手动步骤 —— 升级重启即可;插件已 seed,预设已在
> 随包 home 中。

## 使用

1. 新建会话时，在预设选择器中选择 **只读安全审计 / Read-only audit mode**。
2. 告诉 AI 要审计的对象（例如“请审计当前目录”）。AI 必须先询问报告交付方式；用户未选择前不能开始读代码。
3. AI 阅读源码、依赖清单和配置文件，产出 Markdown 安全审计报告。
4. 选择“对话直接回复”时，报告显示在对话中；选择“生成报告文件”时，最后一步 `write` 会弹出审批。拒绝则不生成文件；批准则只在会话工作区内写入 `SECURITY_AUDIT_REPORT.md`。
5. 该预设本身即只读；只有确实想为当前会话退出审计模式时，才输入 `/readonly-audit off`。

## 验证与排障

重启后逐项检查：

1. 预设选择器里有 **只读安全审计 / Read-only audit mode**。
2. 使用该预设创建会话成功。
3. AI 在读取任何内容前先询问报告交付方式。
4. 尝试写文件会被拒绝，提示 `[readonly-audit] 只读安全审计模式`。
5. 选择“生成报告文件”时，最终写入会请求批准；拒绝则不生成文件。

模式没出现时：

```sh
ls "$DSH_HOME/.agent-presets/readonly-audit"
# 必须包含 agent.cordis.yml 和 preset.yml
```

创建会话报找不到 `dsh-readonly-security-audit` 时，请对同一个 profile 和
`DSH_HOME` 重新执行插件安装步骤。

## 可选配置

bundle patch 在宿主平面以 `disabled: true` 插入插件；`readonly-audit` 预设会以 `active: true` 挂载它。如需自定义报告路径或增加部署专用只读工具，可在预设文件或 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: readonly-security-audit
  name: dsh-readonly-security-audit
  config:
    active: true
    reportPath: reports/audit.md
    extraReadOnlyTools: []
    extraMutatingTools: []
```

`reportPath` 必须是相对路径，且不能逃出会话工作区。若要在其他预设中启用 `/readonly-audit on|off` 命令形式，可在 profile patch 中启用 `readonly-security-audit` 这一行。

## 开发

构建只用于修改插件本身；使用者直接用已入库的 `lib/`。开发需要旁边的 `deepseek-harness` checkout：

```sh
pnpm install
pnpm test       # vitest：模式切换 + 强制门禁测试
pnpm typecheck  # tsc -b（对照 harness checkout）
pnpm build      # tsc 声明 + tsdown 宿主产物到 lib/
```

构建完成后请把 `lib/` 一并提交，link 安装的 profile 只需 `git pull` 即可更新。

## 许可证

Apache-2.0
