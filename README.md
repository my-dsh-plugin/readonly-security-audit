# readonly-security-audit

English | [中文](README.zh.md)

> ## ⚠️ Experimental — read this first
>
> This is an **experimental, plugin-based** implementation of the read-only
> security audit mode. It exists to try out what a plugin layer can add **on
> top of** a plain preset. For everyday use, prefer the **native preset
> approach**: a pure-preset, script-installable edition lives in the
> [`dsh-presets`](https://github.com/my-dsh-plugin/dsh-presets) repository
> (`readonly-audit/`), needs no custom plugin, and installs with one command
> on any host (bash / PowerShell). See the "Recommended alternative" section
> below.
>
> ### What the plugin layer adds (the experiment)
>
> Compared with the native pure-preset edition, this plugin attempts:
>
> - **Automatic read-only** — entering audit mode switches the session's
>   sandbox to `read-only` by itself, so the deployment does not need to
>   configure `sandbox-policy` to a read-only default;
> - **Tool-level allowlist gate** — an outermost `tools/pre-execute` listener
>   rejects every non-allowlisted tool call, not just filesystem mutations;
> - **Mandatory report-delivery choice** — the model cannot start reading
>   before the user picks conversation or file delivery;
> - **Per-session slash commands** — `/readonly-audit on|off|status`;
> - **One-shot write approval with auto-restore** — an approved report write
>   widens only that single call to `workspace-write` and restores
>   `read-only` immediately after.
>
> These are exactly the capabilities a preset file alone cannot express.
> If they matter to you, install this plugin; otherwise the native preset
> edition below is the recommended, simpler path.
>
> ### Recommended alternative (native preset, scripted install)
>
> ```bash
> bash -c "$(curl -fsSL https://raw.githubusercontent.com/my-dsh-plugin/dsh-presets/main/readonly-audit/install-readonly-audit.sh)"
> ```
>
> Windows PowerShell:
>
> ```powershell
> irm https://raw.githubusercontent.com/my-dsh-plugin/dsh-presets/main/readonly-audit/install-readonly-audit.ps1 | iex
> ```
>
> Trade-off: the native edition has **no automatic read-only** — the
> deployment's `sandbox-policy` default must already be `read-only` (or the
> session must be switched manually), and there is no tool-level allowlist
> gate or mandatory delivery choice. It is still fully read-only at the
> enforcement layer for everything it mounts.

---

A new **read-only security audit mode** for DeepSeek Harness. It appears in the agent-preset picker beside Standard, PTC, Minimal, and Creator: **只读安全审计 / Read-only audit mode**. The assistant may read and analyze code, dependencies, and configuration, while every file mutation is rejected by the system unless the user approves one exact write.

## What it does

- The `readonly-audit` agent preset starts the session already in audit mode (`active: true`); no slash command is required to enter it.
- `/readonly-audit off` leaves the mode for the current session and restores its previous sandbox/approval policy; `/readonly-audit on` and `/readonly-audit status` are also available.
- Entering the mode writes `sandbox/mode: read-only`, so the harness's existing filesystem and process sandboxes reject file writes (`write`, `edit`, bash commands that touch files) at the enforcement layer, not by prompt good will.
- The plugin also registers an outermost `tools/pre-execute` gate. In audit mode every tool call must be an allowlisted reader (`read`, `read_image`, `glob`, `grep`, `str_replace_editor view`, sandboxed `bash`/`pwsh`, web read/search, ask tools) or an explicitly approved single mutation. Everything else fails with `[readonly-audit] 只读安全审计模式`.
- Before the audit starts, the model is forced to call `choose_audit_report_delivery`. The user chooses:
  - **对话直接回复** — the final report is printed in the conversation; no file is created.
  - **生成报告文件** — at the end the assistant writes `SECURITY_AUDIT_REPORT.md`. That single write is sent through the approval channel; only an explicit user approval temporarily widens the session to `workspace-write`, and the plugin restores `read-only` immediately after the call.
- The report contract requires, for each finding: problem description, severity, location, evidence, and a text-only remediation suggestion. The assistant never fixes code in this mode.

## Why it is enforced, not prompted

1. `readonly-audit/mode` and `readonly-audit/delivery` are durable session events; resume/fork restore them by replay.
2. The session's `sandbox/mode` is set to `read-only`. The stock `dsh-fs-sandbox` and `dsh-bash-sandbox` backends enforce this for filesystem tools and subprocesses.
3. A prepended `tools/pre-execute` listener blocks every non-reader tool call before dispatch. If the mounted shell executor cannot enforce read-only, `bash`/`pwsh` are refused outright.
4. Approved writes are one-shot and one-tool-call only: `workspace-write` is appended after approval, and `tools/post-execute` appends `read-only` again. The built-in `sandbox_permissions` escalation ladder is rejected in audit mode, so an approved report write cannot become full access.

## Install on any DeepSeek Harness checkout or fork

This plugin is not tied to one checkout path. The same instructions work for an
upstream checkout, a personal fork such as `deepseek-harness-fork`, a packaged
Harness install, or another machine.

There are exactly two things to install:

1. the plugin package into a profile;
2. the `readonly-audit` agent preset where the Harness preset roster can see it.

No build is required on the target machine — the repository ships `lib/`.

### 1. Install the plugin into a profile

Generic form, using the target checkout's own `dsh` CLI:

```sh
cd /path/to/your-deepseek-harness

DSH_HOME=/path/to/your-dsh-home \
  node apps/cli/lib/bin.js plugin \
  --profile web \
  add /path/to/readonly-security-audit
```

If your checkout exposes `pnpm dsh`, the equivalent is:

```sh
cd /path/to/your-deepseek-harness

DSH_HOME=/path/to/your-dsh-home \
  pnpm dsh plugin add --profile web /path/to/readonly-security-audit
```

Straight from git:

```sh
DSH_HOME=/path/to/your-dsh-home \
  node apps/cli/lib/bin.js plugin \
  --profile web \
  add github:my-dsh-plugin/readonly-security-audit
```

Offline tarball:

```sh
DSH_HOME=/path/to/your-dsh-home \
  node apps/cli/lib/bin.js plugin \
  --profile web \
  add /tmp/dsh-readonly-security-audit-0.1.0.tgz
```

Manual equivalent in the profile's `package.json`:

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

### 2. Make the mode appear in the preset picker

Choose either path. They are interchangeable.

#### Path A — the checkout already ships the preset

If the target Harness already contains:

```text
apps/cli/config/agent-presets/readonly-audit/
```

then no preset install step is needed. Install the plugin, restart, and the
mode appears as a built-in preset.

#### Path B — install the preset into the writable user root

This works for forks and older checkouts without touching their source:

```sh
cd /path/to/readonly-security-audit

DSH_HOME=/path/to/your-dsh-home \
  node scripts/install-preset.mjs
```

With the default `~/.dsh` home:

```sh
cd /path/to/readonly-security-audit
node scripts/install-preset.mjs
```

Verify it landed in the right home:

```sh
ls "$DSH_HOME/.agent-presets/readonly-audit"
# agent.cordis.yml
# preset.yml
```

Then fully restart the Harness.

### Example: a personal fork

```sh
# 1. Install the plugin into the fork's web profile
cd /path/to/deepseek-harness-fork
DSH_HOME=/path/to/fork-dsh-home \
  node apps/cli/lib/bin.js plugin \
  --profile web \
  add /path/to/readonly-security-audit

# 2. Install the preset into that same DSH_HOME
cd /path/to/readonly-security-audit
DSH_HOME=/path/to/fork-dsh-home \
  node scripts/install-preset.mjs

# 3. Restart the fork
cd /path/to/deepseek-harness-fork
DSH_HOME=/path/to/fork-dsh-home \
  node apps/cli/lib/bin.js web
```

If you prefer the mode to look like a built-in fork preset, copy the preset
directory into the fork instead of using `DSH_HOME`:

```sh
mkdir -p /path/to/deepseek-harness-fork/apps/cli/config/agent-presets/readonly-audit
cp /path/to/readonly-security-audit/presets/readonly-audit/* \
   /path/to/deepseek-harness-fork/apps/cli/config/agent-presets/readonly-audit/
```

### Migrating to another machine

1. Copy or clone the plugin repository to the new machine, or pack it first:

   ```sh
   cd readonly-security-audit
   pnpm pack --pack-destination /tmp
   # /tmp/dsh-readonly-security-audit-0.1.0.tgz
   ```

2. On the target machine, run the same two steps:
   - install the plugin into the target profile;
   - run `scripts/install-preset.mjs` against the target `DSH_HOME`.
3. Restart and verify below.

The only consistency rule is: **the plugin, the preset, and the Harness process
must all use the same `DSH_HOME`.**

## Use

1. Create a session and select **只读安全审计 / Read-only audit mode** from the preset picker.
2. Tell the assistant what to audit (for example `请审计当前目录`). The assistant must first ask how to deliver the report; it cannot start reading before the user chooses.
3. The assistant reads source, manifests, and configuration, then produces a Markdown security report.
4. For `对话直接回复`, the report appears in the conversation. For `生成报告文件`, the final `write` shows an approval prompt. Rejecting it creates no file; approving it writes only `SECURITY_AUDIT_REPORT.md` in the session workspace.
5. The preset is already read-only; use `/readonly-audit off` only when you deliberately want to leave audit mode for that session.

## Verify and troubleshoot

After restarting, check:

1. The preset picker contains **只读安全审计 / Read-only audit mode**.
2. Creating a session on that preset succeeds.
3. The assistant asks for report delivery before reading anything.
4. An attempted file mutation is rejected with `[readonly-audit] 只读安全审计模式`.
5. A `生成报告文件` write asks for approval; rejecting it creates no file.

If the mode is missing:

```sh
ls "$DSH_HOME/.agent-presets/readonly-audit"
# must contain agent.cordis.yml and preset.yml
```

If the session fails to find `dsh-readonly-security-audit`, re-run the plugin
install step against the same profile and `DSH_HOME`.

## Configuration (optional)

The bundle patch inserts the plugin disabled on the host plane; the `readonly-audit` preset mounts it with `active: true`. Users can override the report path or allowlist deployment-specific readers in the preset file or in their profile `cordis.patch.yml`:

```yaml
- id: readonly-security-audit
  name: dsh-readonly-security-audit
  config:
    active: true
    reportPath: reports/audit.md
    extraReadOnlyTools: []
    extraMutatingTools: []
```

`reportPath` must be relative and stay inside the session workspace. To enable the slash-command host instance in other presets, enable the `readonly-security-audit` row in the profile patch.

## Development

Building is only for changing the plugin; consumers use the committed `lib/`. A sibling `deepseek-harness` checkout is required for the shared TypeScript preset.

```sh
pnpm install
pnpm test       # vitest: mode switch + enforcement-fence suites
pnpm typecheck  # tsc -b against the sibling harness checkout
pnpm build      # tsc declarations + tsdown host entry into lib/
```

After a build, commit `lib/` so installed profiles receive the update with `git pull`.

## License

Apache-2.0
