import { isAbsolute, normalize, sep } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
//#region lib/types/index.js
/**
* read-only security audit mode for the DeepSeek Harness.
*
* The plugin is a deployment-independent mode layer:
* - The shipped `readonly-audit` agent preset mounts it with `active: true`, so
*   sessions created in that preset start in audit mode; a host instance can
*   instead use `/readonly-audit on|off|status` to switch one session manually.
* - Entering the mode appends durable session events and switches the shared
*   sandbox policy to `read-only`, so the existing kernel/process sandbox and
*   `dsh-fs-sandbox` reject every file mutation even if a future tool forgot
*   to ask this plugin.
* - A `tools/pre-execute` gate (registered `prepend`) is the second,
*   tool-registry-level fence: in audit mode every tool must be an allowlisted
*   reader or an explicitly approved single mutation. Unauthorized `write`,
*   `edit`, `str_replace_editor` mutations, shell commands without a confining
*   executor, and every non-allowlisted tool fail with an explicit
*   `[readonly-audit] 只读安全审计模式` message.
* - The model must choose report delivery BEFORE reading anything:
*   `choose_audit_report_delivery` asks the user for `dialog` or `file`.
*   A `file` choice is later written with the ordinary `write` tool; that one
*   call asks for approval and temporarily widens only that session to
*   `workspace-write`, then immediately returns to `read-only`.
*
* @module dsh-readonly-security-audit
*/
/** Slash command name. */
const COMMAND_NAME = "readonly-audit";
/** Model-facing tool that asks the delivery question. */
const CHOOSE_DELIVERY_TOOL = "choose_audit_report_delivery";
/** Default report file name, resolved against the session workspace. */
const DEFAULT_REPORT_PATH = "SECURITY_AUDIT_REPORT.md";
/** User-visible option labels owned by this plugin. */
const DELIVERY_DIALOG_LABEL = "对话直接回复";
const DELIVERY_FILE_LABEL = "生成报告文件";
/** Question id echoed by the user-questions provider. */
const DELIVERY_QUESTION_ID = "readonly-audit-report-delivery";
/** Denial prefix shared by every model-facing blocked-tool message. */
const READONLY_PREFIX = "[readonly-audit] 只读安全审计模式";
/**
* Tools that only read code, configuration, or the outside world. `bash` and
* `pwsh` are handled separately because they are allowlisted only when the
* mounted executor confines commands.
*/
const READONLY_TOOLS = /* @__PURE__ */ new Set([
	"read",
	"read_image",
	"glob",
	"grep",
	"web_search",
	"web_fetch",
	"job_output",
	"job_list",
	"job_kill",
	"ask_user_question",
	CHOOSE_DELIVERY_TOOL
]);
/** Shell tools whose file effects must be enforced by the OS sandbox. */
const SHELL_TOOLS = /* @__PURE__ */ new Set(["bash", "pwsh"]);
/** Whole-call file mutators. */
const FILE_MUTATOR_TOOLS = /* @__PURE__ */ new Set(["write", "edit"]);
/** `str_replace_editor` commands that mutate files. */
const STR_REPLACE_MUTATIONS = /* @__PURE__ */ new Set([
	"create",
	"str_replace",
	"insert"
]);
/**
* Read one `readonly-audit/mode` value from the durable log. With no override
* event the `defaultActive` value wins, which is how an `active: true` preset
* instance starts every session already in audit mode.
*/
function foldAuditMode(events, end = events.length, defaultActive = false) {
	let active = defaultActive;
	let index = 0;
	for (const event of events) {
		if (index >= end) break;
		index += 1;
		if (event.type === "readonly-audit/mode") active = event.data.active;
	}
	return active;
}
/** Read the last selected delivery method, or `null` before a choice. */
function foldAuditDelivery(events) {
	let delivery = null;
	for (const event of events) if (event.type === "readonly-audit/delivery") delivery = event.data.delivery;
	return delivery;
}
/** The latest entry event's saved previous sandbox mode, if any. */
function foldPreviousSandbox(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type === "readonly-audit/mode" && event.data.active) return event.data.previousSandbox;
	}
}
/** The latest entry event's saved previous approval policy, if any. */
function foldPreviousApproval(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type === "readonly-audit/mode" && event.data.active) return event.data.previousApproval;
	}
}
/** Validate and detach plugin configuration. */
function resolveConfig(config = {}) {
	const active = config.active ?? false;
	if (typeof active !== "boolean") throw new Error("readonly-security-audit: active must be a boolean");
	const reportPath = config.reportPath ?? "SECURITY_AUDIT_REPORT.md";
	if (typeof reportPath !== "string" || reportPath.trim().length === 0) throw new Error("readonly-security-audit: reportPath must be a non-empty string");
	if (reportPath.includes("\0")) throw new Error("readonly-security-audit: reportPath must not contain NUL");
	const normalizedReport = normalize(reportPath);
	if (isAbsolute(reportPath) || normalizedReport === ".." || normalizedReport.startsWith(`..${sep}`)) throw new Error("readonly-security-audit: reportPath must stay inside the session workspace");
	const extraReadOnlyTools = new Set(assertToolNameList(config.extraReadOnlyTools, "extraReadOnlyTools"));
	const extraMutatingTools = new Set(assertToolNameList(config.extraMutatingTools, "extraMutatingTools"));
	return {
		active,
		reportPath: reportPath.trim(),
		extraReadOnlyTools,
		extraMutatingTools
	};
}
/** Validate an optional tool-name list config field. */
function assertToolNameList(value, field) {
	if (value === void 0) return [];
	if (Array.isArray(value) === false) throw new Error(`readonly-security-audit: ${field} must be an array of non-empty strings`);
	for (const tool of value) if (typeof tool !== "string" || tool.trim().length === 0) throw new Error(`readonly-security-audit: ${field} entries must be non-empty strings`);
	return value;
}
/** Best-effort message extraction for approval/denial rendering. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** The parsed arguments of one tool execution, when they are an object. */
function argsRecord(arguments_) {
	return typeof arguments_ === "object" && arguments_ !== null ? arguments_ : {};
}
/** Whether `str_replace_editor` arguments select a mutating command. */
function isStrReplaceMutation(args) {
	return STR_REPLACE_MUTATIONS.has(String(args.command ?? ""));
}
/** Whether the call is an unapproved file mutation. */
function isFileMutation(name, args, extraMutatingTools) {
	if (FILE_MUTATOR_TOOLS.has(name) || extraMutatingTools.has(name)) return true;
	return name === "str_replace_editor" && isStrReplaceMutation(args);
}
/**
* Owns the mode: durable state, the slash command, the delivery chooser,
* prompt guidance, and the two enforcement fences.
*/
var ReadonlyAuditController = class extends Service {
	static inject = [
		"tools",
		"systemPrompt",
		"sandboxPolicy",
		"userQuestions"
	];
	config;
	/**
	* Approved single mutations that are currently executing. Keyed by session
	* so the post-execute fence can restore `read-only` exactly once.
	*/
	approvedMutations = /* @__PURE__ */ new WeakMap();
	constructor(ctx, config = {}) {
		super(ctx, "readonlyAudit");
		this.config = resolveConfig(config);
		let disposed = false;
		ctx.systemPrompt.section({
			name: "readonly-audit:policy",
			order: 40,
			text: (context) => {
				const agent = context.agent;
				if (agent === void 0 || this.isActive(agent.session) === false) return "";
				return this.policyText(agent);
			}
		});
		ctx.on("tools/pre-execute", async (exec, next) => {
			if (exec.agent === void 0 || this.isActive(exec.agent.session) === false) return await next();
			return await this.preExecute(exec);
		}, true);
		ctx.on("agent/pre-step", async ({ agent }, next) => {
			const decision = await next();
			if (decision.kind === "reject") return decision;
			if (this.isActive(agent.session)) try {
				this.enforceStandingSandbox(agent.session);
			} catch (error) {
				ctx.logger.warn("readonly-security-audit: failed to restore read-only sandbox at pre-step: %o", error);
			}
			return decision;
		});
		ctx.on("tools/post-execute", async (exec, _result, next) => {
			if (exec.agent !== void 0) this.restoreAfterApprovedMutation(exec.agent, exec.token);
			return await next();
		}, true);
		const reportPath = this.config.reportPath;
		const isActive = (session) => this.isActive(session);
		ctx.tools.register(defineTool({
			name: CHOOSE_DELIVERY_TOOL,
			description: "Use this tool FIRST whenever read-only security audit mode is active and the report delivery method has not been chosen yet. It asks the user to choose between delivering the final security audit report directly in the conversation, or writing it to a report file. Choosing the file option later triggers a one-time user approval for that single write.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						delivery: {
							type: "string",
							required: true,
							enum: ["dialog", "file"]
						},
						report_path: {
							type: "string",
							description: "Default report path for file delivery."
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: value.delivery === "file" ? `The user chose file delivery. Write the final report to ${String(value.report_path ?? reportPath)} at the end of the audit; that write requires one-time approval.` : "The user chose conversation delivery. Present the final report directly in the conversation."
				}]
			},
			async execute(_args, exec) {
				const agent = requireAgent(exec);
				if (isActive(agent.session) === false) throw new Error(`${CHOOSE_DELIVERY_TOOL} is only available in read-only security audit mode`);
				if (disposed) throw new Error("the read-only audit service was reloaded; switch the mode off and on again");
				let answer;
				try {
					answer = await ctx.userQuestions.ask({
						questions: [{
							id: DELIVERY_QUESTION_ID,
							header: "审计报告交付方式",
							question: "安全审计完成后，你希望如何接收审计报告？",
							options: [{
								label: DELIVERY_DIALOG_LABEL,
								description: "报告以 Markdown 文本直接显示在对话中，不创建任何文件。"
							}, {
								label: DELIVERY_FILE_LABEL,
								description: `审计结束后将报告写入 ${reportPath}；该次写入会单独请求你批准。`
							}]
						}],
						agent,
						signal: exec.signal
					});
				} catch (error) {
					if (error instanceof UserQuestionError && error.code === "ASK_CANCELLED") throw new Error("The user dismissed the delivery question; stay in read-only audit mode, stop, and wait for their message.");
					throw error;
				}
				const item = answer.answers.find((entry) => entry.id === DELIVERY_QUESTION_ID);
				const selected = item?.selected[0];
				let delivery;
				if (item !== void 0 && item.selected.length === 1 && selected === "生成报告文件") delivery = "file";
				else if (item !== void 0 && item.selected.length === 1 && selected === "对话直接回复") delivery = "dialog";
				else throw new Error("The delivery choice was not recognized; ask the user again.");
				agent.session.append("readonly-audit/delivery", {
					delivery,
					reportPath
				});
				return {
					delivery,
					...delivery === "file" ? { report_path: reportPath } : {}
				};
			},
			presentCall: () => ({
				card: "generic",
				title: "Audit report delivery",
				kind: "other",
				content: [{
					type: "text",
					text: "Asks the user how to deliver the final security audit report."
				}]
			})
		}));
		ctx.inject(["commands"], (commandCtx) => {
			commandCtx.commands.register({
				name: COMMAND_NAME,
				description: "Enter or leave read-only security audit mode",
				input: { hint: "[on|off|status]" },
				handler: ({ agent, rawInput }) => this.command(agent, rawInput)
			});
		});
		ctx.effect(() => () => {
			disposed = true;
		}, "readonly-security-audit: service lifetime");
	}
	/** Whether audit mode is effective for one session. */
	isActive(session) {
		return foldAuditMode(session.events, session.events.length, this.config.active);
	}
	/** Read mode and delivery state for one live agent. */
	get(agent) {
		return {
			active: this.isActive(agent.session),
			delivery: foldAuditDelivery(agent.session.events)
		};
	}
	/** Switch one session into or out of read-only security audit mode. */
	set(agent, active) {
		const session = agent.session;
		if (this.isActive(session) === active) return "noop";
		if (active) {
			const previousSandbox = this.ctx.sandboxPolicy.resolve({ session }).mode;
			const approval = this.ctx.get("approval");
			const previousApproval = approval === void 0 ? void 0 : approval.overrideOf(session) ?? approval.config.policy ?? "ask";
			session.append("readonly-audit/mode", {
				active: true,
				previousSandbox,
				...previousApproval === void 0 ? {} : { previousApproval }
			});
			session.append("readonly-audit/delivery", { delivery: null });
			this.enforceStandingSandbox(session);
			if (approval !== void 0) approval.setPolicy(agent, "ask");
			this.narrate(agent, true);
			return "committed";
		}
		const previousSandbox = foldPreviousSandbox(session.events) ?? "workspace-write";
		const previousApproval = foldPreviousApproval(session.events) ?? this.ctx.get("approval")?.config.policy ?? "ask";
		session.append("readonly-audit/mode", { active: false });
		session.append("readonly-audit/delivery", { delivery: null });
		if (this.ctx.sandboxPolicy.resolve({ session }).mode !== previousSandbox) setSandboxMode(session, previousSandbox);
		const approval = this.ctx.get("approval");
		if (approval !== void 0) approval.setPolicy(agent, previousApproval);
		this.narrate(agent, false);
		return "committed";
	}
	/** `/readonly-audit` command handler. */
	command(agent, rawInput) {
		const match = /^(on|off|status)(?:\s+(.*))?$/iu.exec(rawInput.trim());
		const verb = match?.[1]?.toLowerCase();
		if (rawInput.trim() === "" || verb === "status") {
			const state = this.get(agent);
			if (!state.active) return {
				kind: "success",
				text: "Read-only security audit mode is off."
			};
			return {
				kind: "success",
				text: `Read-only security audit mode is on; report delivery: ${state.delivery === null ? "not selected yet" : state.delivery === "file" ? `file (${this.config.reportPath})` : "conversation"}.`
			};
		}
		if (verb === "on") {
			const outcome = this.set(agent, true);
			const target = match?.[2]?.trim() ?? "";
			if (target !== "") agent.steer(createUserMessage({
				content: [{
					type: "text",
					text: target
				}],
				source: { kind: "user" }
			}));
			return {
				kind: "success",
				text: outcome === "committed" ? "Read-only security audit mode on. The assistant will ask how to deliver the report before starting." : "Read-only security audit mode is already on."
			};
		}
		if (verb === "off") return {
			kind: "success",
			text: this.set(agent, false) === "committed" ? "Read-only security audit mode off; the previous sandbox and approval policy were restored." : "Read-only security audit mode is already off."
		};
		return {
			kind: "error",
			text: "Usage: /readonly-audit [on|off|status]"
		};
	}
	/** The complete model-facing policy for an active audit session. */
	policyText(agent) {
		const delivery = foldAuditDelivery(agent.session.events);
		return [
			"You are in READ-ONLY SECURITY AUDIT MODE (只读安全审计模式).",
			"The system enforces this mode at the tool and sandbox layers; prompts alone cannot override it.",
			"Allowed work: read files, list directories, search code, view images, and run sandboxed read-only shell commands. Analyze source code, dependency manifests, configuration files, and supply-chain data for vulnerabilities, dangerous APIs, weak configuration, hard-coded secrets, and supply-chain risks.",
			delivery === null ? `DELIVERY CHOICE (mandatory, before any other work): call \`${CHOOSE_DELIVERY_TOOL}\` now and wait for the user's answer. The tool offers exactly two options: "${DELIVERY_DIALOG_LABEL}" and "${DELIVERY_FILE_LABEL}". You must not choose a delivery method yourself, and you must not start reading or analyzing code before the user has chosen.` : delivery === "file" ? `DELIVERY: the user chose file delivery. At the end of the audit, use the \`write\` tool once to create \`${this.config.reportPath}\` in the session workspace. The system will ask the user to approve that single write; it temporarily becomes workspace-write and then returns to read-only. If the user rejects it, do NOT retry or write anywhere else — offer to paste the report into the conversation instead.` : "DELIVERY: the user chose conversation delivery. When the audit is complete, present the complete report directly in your final reply; do not create any file.",
			"FORBIDDEN: modifying, creating, or deleting any file (including temporary files), running build/install/format/generation commands that write, and using any non-allowlisted tool. Unauthorized mutations are rejected by the system with a \"只读安全审计模式\" error.",
			"Do not write any audit working notes or intermediate artifacts to disk. Everything before the final report stays in the conversation.",
			"REPORT CONTENT: produce one Markdown report. Every finding must contain: problem description, severity, location, evidence, and a text-only remediation suggestion. Never edit code yourself — remediation suggestions are text only.",
			"When the audit is finished, follow the DELIVERY rule above. If anything is unclear, use ask_user_question before guessing."
		].join("\n");
	}
	/** Decide one tool call in an active audit session. */
	async preExecute(exec) {
		const session = requireAgent(exec).session;
		this.enforceStandingSandbox(session);
		const delivery = foldAuditDelivery(session.events);
		const args = argsRecord(exec.arguments);
		if (delivery === null && exec.name !== "choose_audit_report_delivery") return {
			kind: "deny",
			reason: `${READONLY_PREFIX}: 审计开始前必须先询问用户选择报告交付方式；call \`${CHOOSE_DELIVERY_TOOL}\` first and wait for the user's choice.`
		};
		if (exec.name === "choose_audit_report_delivery") return { kind: "allow" };
		if (exec.name === "str_replace_editor" && String(args.command ?? "") === "view") return { kind: "allow" };
		if (isFileMutation(exec.name, args, this.config.extraMutatingTools)) return await this.decideMutation(exec, args);
		if (SHELL_TOOLS.has(exec.name)) {
			const shell = this.ctx.get("shell");
			if (shell === void 0 || shell.sandboxMode === void 0) return {
				kind: "deny",
				reason: `${READONLY_PREFIX}: ${exec.name} is blocked because the mounted shell executor cannot enforce the read-only sandbox. Use read/glob/grep/str_replace_editor view instead.`
			};
			this.enforceStandingSandbox(session);
			return { kind: "allow" };
		}
		if (READONLY_TOOLS.has(exec.name) || this.config.extraReadOnlyTools.has(exec.name)) return { kind: "allow" };
		return {
			kind: "deny",
			reason: `${READONLY_PREFIX}: tool "${exec.name}" is not in the read-only allowlist and was blocked by the system.`
		};
	}
	/**
	* Ask for one-time approval of a mutating tool call, widen the session to
	* `workspace-write` for exactly that call, and mark it for post-execute
	* restoration.
	*/
	async decideMutation(exec, args) {
		const agent = requireAgent(exec);
		const session = agent.session;
		this.enforceStandingSandbox(session);
		if (args.sandbox_permissions !== void 0 || args.justification !== void 0) return {
			kind: "deny",
			reason: `${READONLY_PREFIX}: sandbox escalation is disabled in audit mode. Retry without sandbox_permissions/justification; this single file operation has its own one-time approval.`
		};
		const approval = this.ctx.get("approval");
		if (approval === void 0) return {
			kind: "deny",
			reason: `${READONLY_PREFIX}: no approval channel is available, so the file operation was blocked (fail closed).`
		};
		let outcome;
		try {
			outcome = await approval.request({
				agent,
				toolName: exec.name,
				callId: exec.callId,
				reason: `Read-only security audit mode: approve this single ${exec.name} file operation? Only this call becomes workspace-write; the session returns to read-only immediately after.`,
				signal: exec.signal
			});
		} catch (error) {
			return {
				kind: "deny",
				reason: `${READONLY_PREFIX}: the approval service failed, so the file operation was blocked (fail closed): ${messageOf(error)}`
			};
		}
		if (outcome !== "allowed-once") return {
			kind: "deny",
			reason: `${READONLY_PREFIX}: ${outcome === "rejected" ? "the user rejected the write; the file was not changed." : outcome === "cancelled" ? "the approval question was cancelled; the write was blocked." : "no approval answerer is available; the write was blocked (fail closed)."}`
		};
		setSandboxMode(session, "workspace-write");
		let approved = this.approvedMutations.get(session);
		if (approved === void 0) {
			approved = /* @__PURE__ */ new Set();
			this.approvedMutations.set(session, approved);
		}
		approved.add(exec.token);
		return { kind: "allow" };
	}
	/** Make the standing sandbox read-only again after an approved mutation. */
	restoreAfterApprovedMutation(agent, token) {
		const session = agent.session;
		const approved = this.approvedMutations.get(session);
		if (approved === void 0) return;
		if (approved.delete(token) === false) return;
		if (approved.size > 0) return;
		try {
			if (this.isActive(session)) this.enforceStandingSandbox(session);
		} catch (error) {
			this.ctx.logger.warn("readonly-security-audit: failed to restore read-only sandbox after approved write: %o", error);
		}
	}
	/** Append `sandbox/mode: read-only` when the session drifted away. */
	enforceStandingSandbox(session) {
		if (this.ctx.sandboxPolicy.resolve({ session }).mode !== "read-only") setSandboxMode(session, "read-only");
	}
	/** Model-facing switch notice, matching the plan-mode convention. */
	narrate(agent, active) {
		const text = active ? "The user switched this session to read-only security audit mode. Ask the user how to deliver the report before reading or analyzing anything; all file mutations are blocked by the system." : "The user switched this session out of read-only security audit mode. Normal file permissions are restored.";
		agent.inject(createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: "plugin",
				plugin: "readonly-security-audit",
				form: "notice",
				summary: text
			}
		}));
	}
};
/** Require a calling agent for tools that act on session state. */
function requireAgent(exec) {
	if (exec.agent === void 0) throw new Error("read-only security audit tools require a calling agent");
	return exec.agent;
}
//#endregion
export { CHOOSE_DELIVERY_TOOL, COMMAND_NAME, DEFAULT_REPORT_PATH, DELIVERY_DIALOG_LABEL, DELIVERY_FILE_LABEL, ReadonlyAuditController, ReadonlyAuditController as default, foldAuditDelivery, foldAuditMode, foldPreviousApproval, foldPreviousSandbox, resolveConfig };
