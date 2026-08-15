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
import { Context, Service } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * Whether read-only security audit mode is in force from this point on.
         * Log-only, non-surface, whole-value replace. The last event wins.
         */
        'readonly-audit/mode': {
            active: boolean;
            /** Sandbox mode to restore when leaving the mode (entry events only). */
            previousSandbox?: SandboxMode;
            /** Approval policy to restore when leaving the mode (entry events only). */
            previousApproval?: ApprovalPolicy;
        };
        /**
         * The selected audit-report delivery method, or `null` when no choice is
         * outstanding for the current audit run. The last event wins.
         */
        'readonly-audit/delivery': {
            delivery: AuditReportDelivery | null;
            /** Default report path used for `file` delivery. */
            reportPath?: string;
        };
    }
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        readonlyAudit: ReadonlyAuditController;
    }
}
/** Delivery choices for the final audit report. */
export type AuditReportDelivery = 'dialog' | 'file';
/** Slash command name. */
export declare const COMMAND_NAME = "readonly-audit";
/** Model-facing tool that asks the delivery question. */
export declare const CHOOSE_DELIVERY_TOOL = "choose_audit_report_delivery";
/** Default report file name, resolved against the session workspace. */
export declare const DEFAULT_REPORT_PATH = "SECURITY_AUDIT_REPORT.md";
/** User-visible option labels owned by this plugin. */
export declare const DELIVERY_DIALOG_LABEL = "\u5BF9\u8BDD\u76F4\u63A5\u56DE\u590D";
export declare const DELIVERY_FILE_LABEL = "\u751F\u6210\u62A5\u544A\u6587\u4EF6";
/** Plugin config. Every field is optional and deployment-independent. */
export interface Config {
    /**
     * Whether this plugin instance starts every agent in audit mode without a
     * `/readonly-audit on` command. The shipped `readonly-audit` agent preset
     * sets this to `true`; ordinary host installs leave it `false` and activate
     * the mode per session through the slash command.
     */
    active?: boolean;
    /**
     * Relative report path for `file` delivery. It must stay inside the session
     * workspace (absolute paths and `..` traversal are refused).
     */
    reportPath?: string;
    /** Additional tool names allowed in audit mode (deployment-specific readers). */
    extraReadOnlyTools?: readonly string[];
    /** Additional tool names treated as whole-call file mutators. */
    extraMutatingTools?: readonly string[];
}
/** Config after validation and defaults. */
export interface ResolvedConfig {
    readonly active: boolean;
    readonly reportPath: string;
    readonly extraReadOnlyTools: ReadonlySet<string>;
    readonly extraMutatingTools: ReadonlySet<string>;
}
/**
 * Read one `readonly-audit/mode` value from the durable log. With no override
 * event the `defaultActive` value wins, which is how an `active: true` preset
 * instance starts every session already in audit mode.
 */
export declare function foldAuditMode(events: readonly SessionEvent[], end?: number, defaultActive?: boolean): boolean;
/** Read the last selected delivery method, or `null` before a choice. */
export declare function foldAuditDelivery(events: readonly SessionEvent[]): AuditReportDelivery | null;
/** The latest entry event's saved previous sandbox mode, if any. */
export declare function foldPreviousSandbox(events: readonly SessionEvent[]): SandboxMode | undefined;
/** The latest entry event's saved previous approval policy, if any. */
export declare function foldPreviousApproval(events: readonly SessionEvent[]): ApprovalPolicy | undefined;
/** Validate and detach plugin configuration. */
export declare function resolveConfig(config?: Config): ResolvedConfig;
/**
 * Owns the mode: durable state, the slash command, the delivery chooser,
 * prompt guidance, and the two enforcement fences.
 */
export declare class ReadonlyAuditController extends Service {
    static inject: string[];
    private readonly config;
    /**
     * Approved single mutations that are currently executing. Keyed by session
     * so the post-execute fence can restore `read-only` exactly once.
     */
    private readonly approvedMutations;
    constructor(ctx: Context, config?: Config);
    /** Whether audit mode is effective for one session. */
    private isActive;
    /** Read mode and delivery state for one live agent. */
    get(agent: Agent): {
        active: boolean;
        delivery: AuditReportDelivery | null;
    };
    /** Switch one session into or out of read-only security audit mode. */
    set(agent: Agent, active: boolean): 'committed' | 'noop';
    /** `/readonly-audit` command handler. */
    private command;
    /** The complete model-facing policy for an active audit session. */
    private policyText;
    /** Decide one tool call in an active audit session. */
    private preExecute;
    /**
     * Ask for one-time approval of a mutating tool call, widen the session to
     * `workspace-write` for exactly that call, and mark it for post-execute
     * restoration.
     */
    private decideMutation;
    /** Make the standing sandbox read-only again after an approved mutation. */
    private restoreAfterApprovedMutation;
    /** Append `sandbox/mode: read-only` when the session drifted away. */
    private enforceStandingSandbox;
    /** Model-facing switch notice, matching the plan-mode convention. */
    private narrate;
}
export default ReadonlyAuditController;
//# sourceMappingURL=index.d.ts.map