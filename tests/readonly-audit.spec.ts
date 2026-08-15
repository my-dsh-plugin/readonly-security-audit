/**
 * Host-side tests for read-only security audit mode: durable folds, the
 * `/readonly-audit` switch, the mandatory delivery chooser, and the two
 * enforcement fences (tool registry pre-execute + sandbox-policy restore).
 *
 * The suite drives the real plugin over real ToolRuntime/SystemPrompt services
 * and minimal fake sandbox-policy/approval/user-questions/shell collaborators.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { effectiveApprovalPolicy, type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ReadonlyAuditController, {
  CHOOSE_DELIVERY_TOOL,
  COMMAND_NAME,
  DELIVERY_DIALOG_LABEL,
  DELIVERY_FILE_LABEL,
  foldAuditDelivery,
  foldAuditMode,
  resolveConfig,
} from '../src/index.ts'

const testSignal = new AbortController().signal

interface TestAgent extends Agent {
  injected: UserMessage[]
  steered: UserMessage[]
}

/** A minimal agent with the durable Session and inbox methods the plugin uses. */
function makeAgent(id: string): TestAgent {
  const session = Session.create(SessionId(id))
  const agent = {
    id: SessionId(id),
    session,
    options: {},
    injected: [],
    steered: [],
    inject(message: UserMessage) {
      this.injected.push(message)
      session.append('user/message', message, { surfaceOp: 'append' })
    },
    steer(message: UserMessage) {
      this.steered.push(message)
      session.append('user/message', message, { surfaceOp: 'append' })
    },
  } as unknown as TestAgent
  return agent
}

interface FakeSandboxPolicy {
  defaultMode: SandboxMode
  workspaceRoot: string
  resolve(request: { session?: Session }): { mode: SandboxMode; workspaceRoot: string; sessionId?: SessionId }
  overrideOf(session: Session): SandboxMode | undefined
}

function makeSandboxPolicy(defaultMode: SandboxMode = 'workspace-write'): FakeSandboxPolicy {
  return {
    defaultMode,
    workspaceRoot: '/workspace',
    resolve({ session } = {}) {
      return {
        mode: session === undefined
          ? defaultMode
          : effectiveSandboxMode(session.events) ?? defaultMode,
        workspaceRoot: session?.header.cwd ?? '/workspace',
        ...session === undefined ? {} : { sessionId: session.id },
      }
    },
    overrideOf(session: Session) {
      return effectiveSandboxMode(session.events)
    },
  }
}

interface FakeApproval {
  config: { policy: 'ask' | 'never' }
  requests: ApprovalRequest[]
  outcomes: ApprovalOutcome[]
  overrideOf(session: Session): 'ask' | 'never' | undefined
  setPolicy(agent: Agent, policy: 'ask' | 'never'): void
  request(request: ApprovalRequest): Promise<ApprovalOutcome>
}

function makeApproval(outcomes: ApprovalOutcome[] = [], config: FakeApproval['config'] = { policy: 'ask' }): FakeApproval {
  return {
    config,
    requests: [],
    outcomes,
    overrideOf(session: Session) {
      return effectiveApprovalPolicy(session.events)
    },
    setPolicy(agent: Agent, policy: 'ask' | 'never') {
      agent.session.append('approval/policy', { policy })
    },
    async request(request: ApprovalRequest) {
      this.requests.push(request)
      return this.outcomes.shift() ?? 'allowed-once'
    },
  }
}

interface FakeQuestions {
  ask: ReturnType<typeof vi.fn>
}

function makeQuestions(selected: string[] = [DELIVERY_DIALOG_LABEL]): FakeQuestions {
  const ask = vi.fn(async () => ({
    answers: [{
      id: 'readonly-audit-report-delivery',
      selected,
      ...(selected.length === 0 ? { custom: '' } : {}),
    }],
  }))
  return { ask }
}

async function setup(options: {
  defaultSandbox?: SandboxMode
  approval?: FakeApproval
  questions?: FakeQuestions
  withCommands?: boolean
  shellConfined?: boolean
  pluginConfig?: ConstructorParameters<typeof ReadonlyAuditController>[1]
} = {}): Promise<{ ctx: Context; agent: TestAgent; approval: FakeApproval; questions: FakeQuestions }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('sandboxPolicy', makeSandboxPolicy(options.defaultSandbox ?? 'workspace-write'))
  ctx.provide('userQuestions', options.questions ?? makeQuestions())
  const approval = options.approval ?? makeApproval()
  ctx.provide('approval', approval)
  ctx.provide('shell', options.shellConfined === false
    ? { run() { throw new Error('not implemented') } }
    : { sandboxMode: options.defaultSandbox ?? 'workspace-write' })
  if (options.withCommands === true) await ctx.plugin(CommandRuntime)
  await ctx.plugin(ReadonlyAuditController, options.pluginConfig ?? {})
  const agent = makeAgent('agent-1')
  return { ctx, agent, approval, questions: options.questions ?? ctx.get('userQuestions') as FakeQuestions }
}

/** Register one simple tool under the real registry. */
function registerTool(ctx: Context, definition: ToolDefinition): void {
  ctx.tools.register(definition)
}

function contentTool(name: string, ran: () => void = () => {}): ToolDefinition {
  return defineContentToolFixture({
    name,
    description: `test ${name}`,
    parameters: {},
    execute: () => {
      ran()
      return Promise.resolve([{ type: 'text', text: `ran ${name}` }])
    },
  })
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent,
    signal: testSignal,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

function messageText(message: UserMessage): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

function sandboxEvents(session: Session): SandboxMode[] {
  return session.events
    .filter((event): event is SessionEvent & { type: 'sandbox/mode'; data: { mode: SandboxMode } } => event.type === 'sandbox/mode')
    .map(event => event.data.mode)
}

describe('resolveConfig', () => {
  it('applies defaults and rejects report paths escaping the workspace', () => {
    expect(resolveConfig()).toMatchObject({ active: false, reportPath: 'SECURITY_AUDIT_REPORT.md' })
    expect(() => resolveConfig({ reportPath: '../outside.md' })).toThrow(/workspace/)
    expect(() => resolveConfig({ reportPath: '/etc/passwd' })).toThrow(/workspace/)
    expect(() => resolveConfig({ extraReadOnlyTools: 'custom_reader' as never }))
      .toThrow(/array of non-empty strings/)
  })
})

describe('durable folds', () => {
  it('takes the last mode/delivery event', () => {
    const session = Session.create(SessionId('fold'))
    expect(foldAuditMode(session.events)).toBe(false)
    expect(foldAuditDelivery(session.events)).toBeNull()
    session.append('readonly-audit/mode', { active: true, previousSandbox: 'workspace-write', previousApproval: 'ask' })
    session.append('readonly-audit/delivery', { delivery: 'dialog' })
    session.append('readonly-audit/delivery', { delivery: 'file', reportPath: 'AUDIT.md' })
    expect(foldAuditMode(session.events)).toBe(true)
    expect(foldAuditDelivery(session.events)).toBe('file')
    session.append('readonly-audit/mode', { active: false })
    expect(foldAuditMode(session.events)).toBe(false)
  })
})

describe('mode switch', () => {
  it('entering pins read-only sandbox + ask approval, clears delivery, and can restore on exit', async () => {
    const { ctx, agent } = await setup({ withCommands: true })
    expect(ctx.readonlyAudit.get(agent)).toEqual({ active: false, delivery: null })

    expect(ctx.readonlyAudit.set(agent, true)).toBe('committed')
    expect(ctx.readonlyAudit.get(agent)).toEqual({ active: true, delivery: null })
    expect(sandboxEvents(agent.session).at(-1)).toBe('read-only')
    expect(agent.session.events.some(event => event.type === 'approval/policy'
      && event.data.policy === 'ask')).toBe(true)
    expect(agent.injected.map(messageText)).toContain('The user switched this session to read-only security audit mode. Ask the user how to deliver the report before reading or analyzing anything; all file mutations are blocked by the system.')

    expect(ctx.readonlyAudit.set(agent, false)).toBe('committed')
    expect(ctx.readonlyAudit.get(agent).active).toBe(false)
    expect(sandboxEvents(agent.session).at(-1)).toBe('workspace-write')
  })

  it('starts active when configured as a preset mode, and /off leaves it for the session', async () => {
    const { ctx, agent } = await setup({ pluginConfig: { active: true }, withCommands: true })
    expect(ctx.readonlyAudit.get(agent)).toEqual({ active: true, delivery: null })

    // The preset is already active, so the enter command is a no-op; leaving
    // records a durable off override for this session.
    expect(ctx.readonlyAudit.set(agent, true)).toBe('noop')
    const signal = new AbortController().signal
    const off = await ctx.commands.execute(agent, `/${COMMAND_NAME} off`, signal)
    expect(off?.result.kind).toBe('success')
    expect(ctx.readonlyAudit.get(agent).active).toBe(false)

    const on = await ctx.commands.execute(agent, `/${COMMAND_NAME} on`, signal)
    expect(on?.result.kind).toBe('success')
    expect(ctx.readonlyAudit.get(agent).active).toBe(true)
  })

  it('registers the slash command and supports on/status/off', async () => {
    const { ctx, agent } = await setup({ withCommands: true })
    const signal = new AbortController().signal
    const on = await ctx.commands.execute(agent, `/${COMMAND_NAME} on`, signal)
    expect(on?.result).toEqual({ kind: 'success', text: expect.stringContaining('on') })
    expect(ctx.readonlyAudit.get(agent).active).toBe(true)

    const status = await ctx.commands.execute(agent, `/${COMMAND_NAME} status`, signal)
    expect(status?.result).toEqual({ kind: 'success', text: expect.stringContaining('not selected yet') })

    const off = await ctx.commands.execute(agent, `/${COMMAND_NAME} off`, signal)
    expect(off?.result.kind).toBe('success')
    expect(ctx.readonlyAudit.get(agent).active).toBe(false)
  })
})

describe('mandatory delivery choice', () => {
  it('blocks every tool except the chooser before the user chooses', async () => {
    const { ctx, agent } = await setup()
    ctx.readonlyAudit.set(agent, true)
    registerTool(ctx, contentTool('read'))

    const blocked = await call(ctx, 'read', {}, agent)
    expect(blocked.isError).toBe(true)
    expect(text(blocked)).toContain('[readonly-audit] 只读安全审计模式')
    expect(text(blocked)).toContain(CHOOSE_DELIVERY_TOOL)

    const chooser = await call(ctx, CHOOSE_DELIVERY_TOOL, {}, agent)
    expect(chooser.isError).toBe(false)
    expect(foldAuditDelivery(agent.session.events)).toBe('dialog')
  })

  it('records file delivery and returns the default report path', async () => {
    const questions = makeQuestions([DELIVERY_FILE_LABEL])
    const { ctx, agent } = await setup({ questions })
    ctx.readonlyAudit.set(agent, true)

    const result = await call(ctx, CHOOSE_DELIVERY_TOOL, {}, agent)
    expect(result.isError).toBe(false)
    expect(foldAuditDelivery(agent.session.events)).toBe('file')
    expect(agent.session.events.findLast(event => event.type === 'readonly-audit/delivery')?.data.reportPath)
      .toBe('SECURITY_AUDIT_REPORT.md')
  })

  it('injects delivery rules into the active system prompt', async () => {
    const { ctx, agent } = await setup()
    ctx.readonlyAudit.set(agent, true)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent }))
    expect(prompt).toContain('READ-ONLY SECURITY AUDIT MODE')
    expect(prompt).toContain(CHOOSE_DELIVERY_TOOL)
  })
})

describe('system-enforced write blocking', () => {
  it('approves one write, then restores read-only sandbox', async () => {
    const { ctx, agent, approval } = await setup()
    ctx.readonlyAudit.set(agent, true)
    agent.session.append('readonly-audit/delivery', { delivery: 'file' })
    let ran = false
    registerTool(ctx, contentTool('write', () => { ran = true }))

    const result = await call(ctx, 'write', { file_path: 'AUDIT.md', content: '# report' }, agent)
    expect(result.isError).toBe(false)
    expect(ran).toBe(true)
    expect(approval.requests).toHaveLength(1)
    expect(approval.requests[0]).toMatchObject({ toolName: 'write' })
    expect(sandboxEvents(agent.session)).toEqual(['read-only', 'workspace-write', 'read-only'])
  })

  it('restores read-only even when an approved write body throws', async () => {
    const { ctx, agent } = await setup()
    ctx.readonlyAudit.set(agent, true)
    agent.session.append('readonly-audit/delivery', { delivery: 'file' })
    registerTool(ctx, defineContentToolFixture({
      name: 'write',
      description: 'test write',
      parameters: {},
      execute: () => Promise.reject(new Error('write exploded after approval')),
    }))

    const result = await call(ctx, 'write', { file_path: 'AUDIT.md', content: '# report' }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('write exploded')
    expect(sandboxEvents(agent.session)).toEqual(['read-only', 'workspace-write', 'read-only'])
  })

  it('rejects a write when the user declines, and never executes it', async () => {
    const { ctx, agent, approval } = await setup({ approval: makeApproval(['rejected']) })
    ctx.readonlyAudit.set(agent, true)
    agent.session.append('readonly-audit/delivery', { delivery: 'file' })
    let ran = false
    registerTool(ctx, contentTool('write', () => { ran = true }))

    const result = await call(ctx, 'write', { file_path: 'AUDIT.md', content: '# report' }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('[readonly-audit] 只读安全审计模式')
    expect(text(result)).toContain('rejected')
    expect(ran).toBe(false)
    expect(sandboxEvents(agent.session).at(-1)).toBe('read-only')
  })

  it('denies built-in sandbox escalation args in audit mode', async () => {
    const { ctx, agent, approval } = await setup()
    ctx.readonlyAudit.set(agent, true)
    agent.session.append('readonly-audit/delivery', { delivery: 'file' })
    registerTool(ctx, contentTool('write'))

    const result = await call(ctx, 'write', {
      file_path: 'AUDIT.md',
      content: '# report',
      sandbox_permissions: 'danger-full-access',
      justification: 'escape audit mode',
    }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('escalation is disabled')
    expect(approval.requests).toHaveLength(0)
  })

  it('fails closed when no approval channel is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('sandboxPolicy', makeSandboxPolicy())
    ctx.provide('userQuestions', makeQuestions())
    ctx.provide('shell', { sandboxMode: 'workspace-write' })
    await ctx.plugin(ReadonlyAuditController)
    const agent = makeAgent('agent-no-approval')
    ctx.readonlyAudit.set(agent, true)
    agent.session.append('readonly-audit/delivery', { delivery: 'file' })
    registerTool(ctx, contentTool('write'))

    const result = await call(ctx, 'write', { file_path: 'AUDIT.md', content: '# report' }, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no approval channel')
    expect(text(result)).toContain('只读安全审计模式')
  })
})

describe('read-only tool gate', () => {
  it('allows allowlisted readers after delivery choice', async () => {
    const { ctx, agent } = await setup()
    ctx.readonlyAudit.set(agent, true)
    agent.session.append('readonly-audit/delivery', { delivery: 'dialog' })
    registerTool(ctx, contentTool('read'))
    registerTool(ctx, contentTool('grep'))
    registerTool(ctx, contentTool('web_fetch'))

    for (const name of ['read', 'grep', 'web_fetch']) {
      const result = await call(ctx, name, {}, agent)
      expect(result.isError).toBe(false)
    }
  })

  it('allows str_replace_editor view and treats create/str_replace/insert as mutations', async () => {
    const { ctx, agent, approval } = await setup()
    ctx.readonlyAudit.set(agent, true)
    agent.session.append('readonly-audit/delivery', { delivery: 'file' })
    registerTool(ctx, contentTool('str_replace_editor'))

    const view = await call(ctx, 'str_replace_editor', { command: 'view', path: '/repo/a.ts' }, agent)
    expect(view.isError).toBe(false)
    expect(approval.requests).toHaveLength(0)

    const create = await call(ctx, 'str_replace_editor', { command: 'create', path: '/repo/a.ts', file_text: 'x' }, agent)
    expect(create.isError).toBe(false)
    expect(approval.requests.at(-1)).toMatchObject({ toolName: 'str_replace_editor' })
  })

  it('denies unknown and non-allowlisted tools', async () => {
    const { ctx, agent } = await setup()
    ctx.readonlyAudit.set(agent, true)
    agent.session.append('readonly-audit/delivery', { delivery: 'dialog' })
    registerTool(ctx, contentTool('terminal_open'))

    const result = await call(ctx, 'terminal_open', {}, agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not in the read-only allowlist')
    expect(text(result)).toContain('只读安全审计模式')
  })

  it('allows bash only under a confining executor and denies it otherwise', async () => {
    const confined = await setup()
    confined.ctx.readonlyAudit.set(confined.agent, true)
    confined.agent.session.append('readonly-audit/delivery', { delivery: 'dialog' })
    registerTool(confined.ctx, contentTool('bash'))
    const allowed = await call(confined.ctx, 'bash', { command: 'grep -R secret .', description: 'read' }, confined.agent)
    expect(allowed.isError).toBe(false)

    const unconfined = await setup({ shellConfined: false })
    unconfined.ctx.readonlyAudit.set(unconfined.agent, true)
    unconfined.agent.session.append('readonly-audit/delivery', { delivery: 'dialog' })
    registerTool(unconfined.ctx, contentTool('bash'))
    const blocked = await call(unconfined.ctx, 'bash', { command: 'grep -R secret .', description: 'read' }, unconfined.agent)
    expect(blocked.isError).toBe(true)
    expect(text(blocked)).toContain('cannot enforce the read-only sandbox')
  })
})
