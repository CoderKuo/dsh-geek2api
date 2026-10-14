/**
 * Route Claude models through the local Claude Code CLI.
 *
 * When the Claude runtime setting is `cli`, selecting a Claude model runs the
 * local Claude Code CLI instead of an HTTP request (useful when a key's group
 * only serves the official CLI). Every other model, and every Claude model on
 * the default `http` runtime, keeps using the pi-ai adapter untouched — this
 * adapter only dispatches.
 *
 * A CLI-backed turn is a *delegation*: the CLI runs its own agent loop with
 * its own tools and returns one answer. The CLI cannot call the harness's
 * tools, so `options.tools` is deliberately not forwarded, and the harness's
 * system prompt is dropped in favour of the CLI's own. The delegation
 * instructions travel as `--append-system-prompt`; the recent conversation
 * travels as one user message whose images are real image blocks, read from
 * the attachment store, so the CLI's model sees them as images. While it
 * works, its thinking and tool activity stream into a reasoning block and its
 * answer streams as text.
 *
 * A session-title request is not a delegation: it runs on the small model,
 * read-only and outside the workspace, with the title instructions appended,
 * so naming a session does not cost an Opus agent turn.
 *
 * @module dsh-geek2api/claude-adapter
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import { LlmAdapter } from '@deepseek-ai/dsh-llm'

import { classifyCapacity, classifyClientPolicy, classifyCoverage, explainCliCapacityFailure, explainCliClientPolicyFailure, explainCliGroupFailure } from './failures.js'

/** Models this route serves through the CLI rather than an HTTP API. */
export const CLI_BACKED_MODEL_IDS = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'])

/** The model a session title is generated with when the session runs on the CLI. */
export const TITLE_MODEL_ID = 'claude-haiku-4-5-20251001'

/**
 * HTTP models whose session titles run on another model of the same route.
 * A title is a few words, so the flagship `gpt-6-astra` hands it to
 * `gpt-6.1-sol`, which the same GPT groups serve; the session's own turns
 * are untouched.
 */
export const TITLE_MODEL_ROUTES = Object.freeze({ 'gpt-6-astra': 'gpt-6.1-sol' })

/** How much of the conversation a delegated prompt carries. */
const MAX_PROMPT_CHARS = 48_000
const MAX_BLOCK_CHARS = 8_000
const TRUNCATED_MARK = '…（较早对话已截断）'

/**
 * Image bounds for one delegated turn. Each image is re-encoded by the
 * attachment store to the same request version the HTTP route sends (at most
 * 2048×2048 pixels, about 1 MiB); the oldest images are left out once the turn
 * would carry more than 20 of them or 20 MiB of base64.
 */
export const CLI_IMAGE_LIMITS = Object.freeze({
  maxPixels: 2048 * 2048,
  maxBytesPerImage: 1024 * 1024,
  maxTotalBase64Bytes: 20 * 1024 * 1024,
  maxImages: 20,
})
/** The vendor's per-image cap on base64 data; a fallback read above it is not sent. */
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024

const base64Length = bytes => Math.ceil(bytes / 3) * 4

/** A short name for an image or file a reader can match to the chat. */
function attachmentName(ref) {
  if (typeof ref?.name === 'string' && ref.name !== '') return ref.name
  const id = String(ref?.attachmentId ?? '')
  return id.startsWith('sha256:') ? id.slice(7, 15) : id.slice(0, 8)
}

/** The host path of a stored attachment, when the store is file-backed. */
function hostPath(lookup) {
  try {
    const value = lookup()
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/** The only PTC program this adapter emits; its JSON literal also works in Python. */
const PLAN_REVIEW_PROGRAM_PREFIX = 'return await tools.exit_plan_mode('

/** Parse durable arguments without evaluating model-authored code. */
function parsedArguments(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return undefined
  }
}

/**
 * Recover only the public plan, never arbitrary tool arguments or PTC code.
 * The PTC allowlist is deliberately the exact, single-call program we emit.
 */
function planOfCall(block) {
  if (block?.type !== 'tool-call') return undefined
  const args = parsedArguments(block.arguments)
  let plan
  if (block.name === 'exit_plan_mode') plan = args?.plan
  else if (block.name === 'run_code' && typeof args?.code === 'string') {
    const code = args.code
    if (!code.startsWith(PLAN_REVIEW_PROGRAM_PREFIX) || !code.endsWith(')')) return undefined
    const review = parsedArguments(code.slice(PLAN_REVIEW_PROGRAM_PREFIX.length, -1))
    if (review === null || typeof review !== 'object' || Object.keys(review).length !== 1) return undefined
    plan = review.plan
  }
  return typeof plan === 'string' && plan.trim() !== '' ? plan : undefined
}

/** Keep the latest complete plan and its review from the persisted model transcript. */
function planReviewContext(messages) {
  let latest
  for (const message of messages) {
    if (message?.role !== 'assistant') continue
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const plan = planOfCall(block)
      if (plan !== undefined) latest = { plan, id: block.id }
    }
  }
  if (latest === undefined) return undefined
  let review
  for (const message of messages) {
    if (message?.role !== 'user') continue
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type !== 'tool-result' || latest.id === undefined || block.toolCallId !== latest.id) continue
      const text = typeof block.content === 'string'
        ? block.content
        : (Array.isArray(block.content) ? block.content : []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
      review = `[计划审阅${block.isError === true ? '未批准/失败' : '结果'}]\n${text}`
    }
  }
  return {
    id: latest.id,
    turn: {
      label: '计划审阅上下文',
      parts: [{ kind: 'text', text: `[最近提交的完整计划；提交本身不代表已批准]\n${latest.plan}\n\n${review ?? '[尚无计划审阅结果；不要把提交视为实施许可]'}` }],
    },
  }
}

/**
 * Select the review transport from this request's actual direct-tool catalog.
 * `run_code` binds `tools` in both supported host language flavors.
 */
function planReviewCall(options, plan) {
  if (plan.trim() === '') throw new Error('Claude Code submitted an empty plan; no review or implementation was authorized.')
  // Reject a plan that cannot even fit by itself before asking for approval.
  // The next request also checks its full review/current-request reservation.
  const context = planReviewContext([{ role: 'assistant', content: [{ type: 'tool-call', name: 'exit_plan_mode', arguments: { plan } }] }]).turn
  if (textLength(context.parts) + context.label.length + 3 >= MAX_PROMPT_CHARS) {
    throw new Error('The submitted plan exceeds the CLI delegation budget (48,000 characters). Shorten or split it before review; no plan constraints were truncated and no implementation was authorized.')
  }
  const tools = Array.isArray(options?.tools) ? options.tools : []
  if (tools.some(tool => tool?.name === 'exit_plan_mode')) return { name: 'exit_plan_mode', args: JSON.stringify({ plan }) }
  if (tools.some(tool => tool?.name === 'run_code')) return {
    name: 'run_code',
    args: JSON.stringify({ code: `${PLAN_REVIEW_PROGRAM_PREFIX}${JSON.stringify({ plan })})`, description: 'Present completed plan for user review' }),
  }
  throw new Error('Claude Code submitted a plan, but this request has neither exit_plan_mode nor run_code available for host review; no implementation was authorized.')
}

/**
 * Flatten one message's content into ordered parts: text, image, and file.
 * Tool calls and results become short text so a turn that started on another
 * model still reads coherently; reasoning is not carried. The latest review
 * result is carried in full separately, not through the general 8k tool cap.
 */
function collectParts(blocks, parts, reviewId) {
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text !== '') parts.push({ kind: 'text', text: block.text })
        break
      case 'image':
        if (block.attachment !== undefined) parts.push({ kind: 'image', ref: block.attachment })
        else parts.push({ kind: 'text', text: '[图片]' })
        break
      case 'file':
        if (block.attachment !== undefined) parts.push({ kind: 'file', ref: block.attachment })
        break
      case 'tool-call':
      case 'tool-call-delta':
        parts.push({ kind: 'text', text: `[调用工具 ${block.name ?? block.id ?? ''}]` })
        break
      case 'tool-result': {
        if (reviewId !== undefined && block.toolCallId === reviewId) break
        if (typeof block.content === 'string') {
          parts.push({ kind: 'text', text: `[工具结果] ${block.content.slice(0, MAX_BLOCK_CHARS)}` })
          break
        }
        const nested = []
        collectParts(block.content, nested)
        let budget = MAX_BLOCK_CHARS
        parts.push({ kind: 'text', text: '[工具结果]' })
        for (const part of nested) {
          if (part.kind !== 'text') {
            parts.push(part)
            continue
          }
          if (budget <= 0) continue
          parts.push({ kind: 'text', text: part.text.slice(0, budget) })
          budget -= part.text.length
        }
        break
      }
      default:
        break
    }
  }
  return parts
}

const textLength = parts => parts.reduce((sum, part) => sum + (part.kind === 'text' ? part.text.length : 0), 0)

/**
 * The conversation as labelled turns, newest last, trimmed to the prompt
 * budget by dropping whole older turns; a single newest turn that is larger
 * than the budget keeps its tail.
 */
function delegatedTurns(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  // Tool arguments are durable on resume/fork, unlike a per-run memory cache or
  // presentCall UI. Reserve the entire latest plan/review before trimming chat.
  const review = planReviewContext(messages)
  const reserved = review === undefined ? 0 : textLength(review.turn.parts) + review.turn.label.length + 3
  const turns = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || message.role === 'system') continue
    const parts = collectParts(message.content, [], review?.id)
    if (parts.length === 0 || (textLength(parts) === 0 && !parts.some(part => part.kind !== 'text'))) continue
    const label = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : String(message.role)
    turns.push({ label, parts })
  }
  const newest = turns.at(-1)
  const newestSize = newest === undefined ? 0 : textLength(newest.parts) + newest.label.length + 3
  if (review !== undefined && reserved + newestSize > MAX_PROMPT_CHARS) {
    throw new Error('The complete plan, its review, and the latest request exceed the CLI delegation budget (48,000 characters). Shorten or split the plan/request before continuing; plan constraints were not truncated.')
  }
  const kept = []
  let used = reserved
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    const size = textLength(turn.parts) + turn.label.length + 3
    if (used + size <= MAX_PROMPT_CHARS) {
      kept.unshift(turn)
      used += size
      continue
    }
    if (kept.length === 0) kept.unshift({ label: turn.label, parts: tailOf(turn.parts, MAX_PROMPT_CHARS - turn.label.length - 3), clipped: true })
    break
  }
  const truncated = kept.length < turns.length || kept[0]?.clipped === true
  if (review !== undefined) kept.unshift(review.turn)
  return { turns: kept, truncated }
}

/** Keep the last `budget` characters of a turn's text, and every part after them. */
function tailOf(parts, budget) {
  const result = []
  let remaining = budget
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part.kind !== 'text') {
      result.unshift(part)
      continue
    }
    if (remaining <= 0) continue
    result.unshift({ kind: 'text', text: part.text.length > remaining ? part.text.slice(-remaining) : part.text })
    remaining -= part.text.length
  }
  return result
}

/** How a part reads when it is carried as text only. */
function partText(part, describe) {
  if (part.kind === 'text') return part.text
  return describe(part)
}

/** Render turns as one transcript, with non-text parts described by `describe`. */
function renderTurns({ turns, truncated }, describe) {
  const transcript = turns
    .map(turn => `${turn.label}：${turn.parts.map(part => partText(part, describe)).join('\n').trim()}`)
    .join('\n\n')
  return truncated ? `${TRUNCATED_MARK}\n\n${transcript}` : transcript
}

const plainDescription = part => (part.kind === 'image' ? `[图片 ${attachmentName(part.ref)}]` : `[文件 ${attachmentName(part.ref)}]`)

/**
 * The delegation instructions, appended to the CLI's own system prompt.
 *
 * The harness system prompt describes tools this model cannot call, so only
 * its opening is passed on, marked as context.
 * @param options - the assembled request.
 * @param cwd - the working directory the CLI will run in, when known.
 * @returns the instructions text.
 */
export function delegationInstructions(options, cwd, { plan = false } = {}) {
  const system = typeof options?.system === 'string' && options.system.trim() !== '' ? options.system.trim() : ''
  const lead = plan
    ? '本回合 DeepSeek Harness 处于计划模式。只做只读探索，把完整实施计划写成以一级标题开头的 Markdown，写入 CLI 指定的计划文件。若有 ExitPlanMode 就调用它；没有也在写完后停下来。不要修改项目、不要开始实施。DeepSeek Harness 会用这份计划打开审阅。'
      + '用户消息是 DeepSeek Harness 会话的近期对话记录，最后一条是当前请求；其中的图片已作为图片随消息附上，「只读副本」路径也可以用 Read 工具读取。'
    : '本回合由 DeepSeek Harness 委派给 Claude Code 执行。用户消息是 DeepSeek Harness 会话的近期对话记录，最后一条是当前请求；'
      + '其中的图片已作为图片随消息附上，「只读副本」路径也可以用 Read 工具读取。'
      + '请用你自己的工具完成任务，直接输出最终结果；不要反问、不要复述流程。'
  return [
    lead,
    cwd === undefined ? undefined : `工作目录：${cwd}`,
    system === '' ? undefined : `补充说明（来自 DeepSeek Harness，其中提到的工具你未必拥有）：${system.slice(0, 2_000)}`,
  ].filter(part => part !== undefined).join('\n')
}

/**
 * The recent conversation as one text transcript. Images and files are named
 * in place; {@link buildDelegatedContent} is what carries the images.
 * @param options - the assembled request.
 * @returns the transcript text.
 */
export function renderDelegatedPrompt(options) {
  return renderTurns(delegatedTurns(options), plainDescription).trim()
}

/**
 * The recent conversation as content blocks for the CLI's stream-json input:
 * the transcript, with every image that fits the turn's bounds as an image
 * block at the place it was sent, labelled with its read-only host copy.
 * An image that is left out, or that cannot be read, is described in text
 * instead; it never fails the turn.
 * @param options - the assembled request.
 * @param context - the attachment store (`ctx.attachments`), image bounds,
 *   and cancellation.
 * @returns text and image blocks, in conversation order.
 */
export async function buildDelegatedContent(options, { attachments, limits = CLI_IMAGE_LIMITS, signal } = {}) {
  const shape = delegatedTurns(options)
  const images = shape.turns.flatMap(turn => turn.parts.filter(part => part.kind === 'image'))
  const pathOf = ref => hostPath(() => attachments?.imageHostPath?.(ref))
  const filePathOf = ref => hostPath(() => attachments?.fileHostPath?.(ref))

  // Newest first: when the bounds bite, the oldest images are the ones left out.
  const carried = new Map()
  const reasons = new Map()
  const reads = new Map()
  let total = 0
  let count = 0
  let full = false
  for (const part of [...images].reverse()) {
    if (attachments === undefined || attachments === null) {
      reasons.set(part, 'unavailable')
      continue
    }
    if (full) {
      reasons.set(part, 'limit')
      continue
    }
    const id = String(part.ref.attachmentId)
    try {
      if (!reads.has(id)) reads.set(id, readRequestImage(attachments, part.ref, limits, signal))
      const image = await reads.get(id)
      const size = base64Length(image.data.byteLength)
      if (size > MAX_IMAGE_BASE64_BYTES) {
        reasons.set(part, 'too-large')
        continue
      }
      if (count + 1 > limits.maxImages || total + size > limits.maxTotalBase64Bytes) {
        full = true
        reasons.set(part, 'limit')
        continue
      }
      count += 1
      total += size
      carried.set(part, image)
    } catch (error) {
      if (signal?.aborted === true) throw error
      reasons.set(part, 'unreadable')
    }
  }

  const blocks = []
  let text = shape.truncated ? `${TRUNCATED_MARK}\n\n` : ''
  const flush = () => {
    if (text !== '') blocks.push({ type: 'text', text })
    text = ''
  }
  for (const [turnIndex, turn] of shape.turns.entries()) {
    text += `${turnIndex === 0 ? '' : '\n\n'}${turn.label}：`
    for (const [partIndex, part] of turn.parts.entries()) {
      const separator = partIndex === 0 ? '' : '\n'
      if (part.kind === 'text') {
        text += separator + part.text
        continue
      }
      if (part.kind === 'file') {
        const path = filePathOf(part.ref)
        text += `${separator}[文件 ${attachmentName(part.ref)}${path === undefined ? '' : `；只读副本：${path}`}]`
        continue
      }
      const path = pathOf(part.ref)
      const copy = path === undefined ? '' : `；只读副本：${path}`
      const image = carried.get(part)
      if (image === undefined) {
        text += `${separator}[图片 ${attachmentName(part.ref)}：${imageOmission(reasons.get(part))}${copy}]`
        continue
      }
      text += `${separator}[图片 ${attachmentName(part.ref)}（${image.width}x${image.height}px）${copy}]`
      flush()
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: Buffer.from(image.data).toString('base64') },
      })
    }
  }
  flush()
  return blocks
}

function imageOmission(reason) {
  switch (reason) {
    case 'limit': return '超出本回合的图片上限，未随消息附上，需要时请用 Read 工具读取'
    case 'too-large': return '图片过大，未随消息附上，需要时请用 Read 工具读取'
    case 'unavailable': return '当前运行环境无法读取附件'
    default: return '读取失败，未随消息附上'
  }
}

/**
 * One request-sized version of a stored image: the store's own request
 * encoder when it has one, otherwise the stored normalized bytes.
 */
async function readRequestImage(attachments, ref, limits, signal) {
  if (typeof attachments.readImageRequest === 'function') {
    const version = await attachments.readImageRequest(ref, { maxPixels: limits.maxPixels, maxBytes: limits.maxBytesPerImage }, signal)
    return { data: version.data, mediaType: version.mediaType ?? ref.mediaType, width: version.width ?? ref.width, height: version.height ?? ref.height }
  }
  const stored = await attachments.readImage(ref, signal)
  return { data: stored.data, mediaType: stored.mediaType ?? ref.mediaType, width: ref.width, height: ref.height }
}

/**
 * The prompt of a one-shot auxiliary request: its messages' text, verbatim.
 * The caller frames its own input, so nothing is added around it.
 * @param options - the assembled request.
 * @returns the prompt text.
 */
export function renderAuxiliaryPrompt(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  return messages
    .filter(message => message !== null && typeof message === 'object' && message.role !== 'system')
    .flatMap(message => (Array.isArray(message.content) ? message.content : []))
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n\n')
    .trim()
}

/**
 * Emit text and reasoning as well-formed harness blocks.
 *
 * The harness's stream grammar requires every delta to address an open block
 * of its own type, so each run of one kind is bracketed by `block-start` and
 * `block-end`. Tool progress goes into reasoning: the UI shows it live as the
 * turn's working process, and it never re-enters a later delegated prompt.
 */
function createBlockWriter() {
  let index = -1
  let open
  const close = function* () {
    if (open === undefined) return
    yield { type: 'block-end', index, block: { type: open.kind, text: open.text } }
    open = undefined
  }
  const write = function* (kind, text) {
    if (typeof text !== 'string' || text === '') return
    if (open?.kind !== kind) {
      yield* close()
      index += 1
      open = { kind, text: '' }
      yield { type: 'block-start', index, blockType: kind }
    }
    open.text += text
    yield { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index, text }
  }
  return {
    /** A CLI content block started; the next write opens a fresh harness block. */
    boundary(kind) {
      if (open !== undefined && open.kind === kind) open.sealed = true
    },
    *write(kind, text) {
      if (open?.sealed === true) yield* close()
      yield* write(kind, text)
    },
    *note(line) {
      const separator = open?.kind === 'reasoning' && open.text !== '' && !open.text.endsWith('\n') ? '\n' : ''
      if (open?.kind === 'reasoning') open.sealed = false
      yield* write('reasoning', `${separator}${line}`)
    },
    /** One complete tool call after whatever text or reasoning is open. */
    *toolCall(id, name, args) {
      yield* close()
      index += 1
      const block = { type: 'tool-call', id, name, arguments: args }
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args }
      yield { type: 'block-end', index, block }
    },
    close,
  }
}

/**
 * The turn's usage in the harness's disjoint buckets.
 *
 * The prompt side is the CLI's *last* request — the context it actually
 * occupied and how much of it hit the cache — because the harness reads the
 * prompt side as context pressure, and summing a multi-step CLI turn would
 * count the same context once per step. Output is the CLI's whole-turn total.
 */
function turnUsage(lastRequest, finished) {
  const outputTokens = finished?.outputTokens ?? 0
  if (lastRequest !== undefined) {
    return {
      inputTokens: lastRequest.inputTokens,
      outputTokens,
      cacheReadTokens: lastRequest.cacheReadTokens,
      cacheWriteTokens: lastRequest.cacheWriteTokens,
    }
  }
  return {
    inputTokens: finished?.inputTokens ?? 0,
    outputTokens,
    cacheReadTokens: finished?.cacheReadTokens ?? 0,
    cacheWriteTokens: finished?.cacheWriteTokens ?? 0,
  }
}

/**
 * One line naming the key a CLI run uses — by its label only — so a key
 * switch is visible on the very next turn, and a key passed over for its
 * groups is never a silent change.
 * @param key - the runner's `key` event.
 * @returns the reasoning note, newline-terminated.
 */
export function keyNote(key) {
  const model = typeof key.model === 'string' && key.model !== '' ? key.model : 'Claude'
  const groups = Array.isArray(key.groups) && key.groups.length > 0 ? `（分组：${key.groups.join('、')}）` : ''
  if (key.switchedFrom !== undefined) {
    return `▸ 当前 Key「${key.switchedFrom}」的分组不能用 ${model}，本轮改用 Key「${key.label}」${groups}\n`
  }
  if (key.uncovered === true) {
    const required = Array.isArray(key.required) && key.required.length > 0 ? `（需要 ${key.required.join(' / ')}）` : ''
    return `▸ 使用 Key「${key.label}」${groups}——注意：已存的 Key 都没有能用 ${model} 的分组${required}\n`
  }
  return `▸ 使用 Key「${key.label}」${groups}\n`
}

/** One line describing a retry the CLI is making on its own. */
function retryNote(event) {
  const status = event.status === undefined ? '出错' : `HTTP ${event.status}`
  const reason = typeof event.error === 'string' && event.error !== '' ? `（${event.error}）` : ''
  const attempt = event.attempt === undefined ? '' : event.maxRetries === undefined ? ` ${event.attempt}` : ` ${event.attempt}/${event.maxRetries}`
  const delay = event.delayMs === undefined ? '' : `，${(event.delayMs / 1000).toFixed(1)} 秒后`
  return `网关返回 ${status}${reason}，CLI 自动重试${attempt}${delay}`
}

/**
 * How one request runs on the CLI: a title request on the small model with
 * the caller's instructions appended, anything else as a delegated turn.
 *
 * The CLI's own system prompt and tool set stay in place even for a title:
 * they are part of what the gateway sees from the official client.
 */
async function cliCall(options, { titleModel, cwdOf, modeOf, attachmentsOf, imageLimits }) {
  if (options?.purpose === 'session-title') {
    return {
      prompt: renderAuxiliaryPrompt(options),
      model: titleModel,
      mode: 'read-only',
      enableSearch: false,
      appendSystemPrompt: typeof options.system === 'string' ? options.system : undefined,
      // Outside the workspace, so the CLI loads no project memory into a title.
      cwd: tmpdir(),
    }
  }
  const cwd = cwdOf()
  const mode = modeOf()
  const content = await buildDelegatedContent(options, { attachments: attachmentsOf(), limits: imageLimits, signal: options?.signal })
  return {
    content,
    appendSystemPrompt: delegationInstructions(options, cwd, { plan: mode === 'plan' }),
    model: options.model,
    mode,
    cwd,
  }
}

/**
 * Wrap an adapter so the CLI-backed models run through the local CLI.
 *
 * @param options - the inner adapter, the CLI runner, the CLI-backed model ids,
 *   the model session titles run on, the HTTP models whose titles run on
 *   another model, the mode and working directory each turn runs with, the
 *   attachment store images are read from, and an optional refresh of a run's
 *   key description (its groups) for explaining a refusal.
 * @returns an adapter with the same provider surface.
 */
export function createClaudeCliAdapter({
  inner,
  runner,
  modelIds = CLI_BACKED_MODEL_IDS,
  /**
   * Whether a model runs through the CLI on this turn. Read per call so the
   * Claude runtime setting applies without reloading the route; defaults to
   * membership in `modelIds`.
   */
  isCliModel,
  titleModel = TITLE_MODEL_ID,
  titleRoutes = TITLE_MODEL_ROUTES,
  resolveMode,
  resolveCwd,
  resolveAttachments,
  imageLimits = CLI_IMAGE_LIMITS,
  explainKey,
}) {
  if (inner === undefined || inner === null) throw new Error('the CLI adapter needs an inner adapter')
  if (runner === undefined || runner === null) throw new Error('the CLI adapter needs a runner')
  const cliModelSet = new Set(modelIds)
  const cliModels = { has: id => (typeof isCliModel === 'function' ? isCliModel(id) === true : cliModelSet.has(id)) }
  /** The model a title request for `model` runs on, when it is rerouted. */
  const titleRouteOf = options => (options?.purpose === 'session-title' && !cliModels.has(options.model)
    ? (Object.hasOwn(titleRoutes, options.model) ? titleRoutes[options.model] : undefined)
    : undefined)
  /** Run a rerouted title on its own model, bound to that model's generation. */
  async function* reroutedTitle(options, model) {
    const prepared = await inner.prepareCall(options.provider, model, options.signal)
    yield* prepared.stream({ ...options, model })
  }
  /** The mode is read per turn so a settings change applies without a reload. */
  const modeOf = () => (typeof resolveMode === 'function' ? resolveMode() : undefined)
  const cwdOf = () => (typeof resolveCwd === 'function' ? resolveCwd() : undefined)
  const attachmentsOf = () => {
    try {
      return typeof resolveAttachments === 'function' ? resolveAttachments() ?? undefined : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Say why a CLI run failed. The request came from the official CLI, so a
   * client-policy refusal gets its own explanation rather than the HTTP
   * route's advice. Geek2API refuses a key without a Claude group either as
   * a routing miss (400 未覆盖供应商, which names the key's groups) or with the
   * official-CLI wording (403); either way the key is the cause, not the CLI.
   * When the run started before the key's groups were known, a fresh reading
   * is consulted first. A busy gateway is named as such after the CLI's own
   * retries ran out.
   */
  async function explainFailure(raw, runKey, { model, retries }) {
    const policy = classifyClientPolicy(raw)
    const coverage = classifyCoverage(raw)
    if (!policy && !coverage) return classifyCapacity(raw) ? explainCliCapacityFailure(raw, retries) : raw
    let key = runKey === undefined ? undefined : { model, ...runKey }
    if (key !== undefined && key.covers !== true && typeof explainKey === 'function') {
      key = await explainKey(key).catch(() => key) ?? key
    }
    if (coverage) return explainCliGroupFailure({ model, ...key, groups: key?.groups }, raw)
    if (key?.covers === false) return explainCliGroupFailure(key, raw)
    const used = key === undefined ? '' : `（本轮使用 Key「${key.label}」${Array.isArray(key.groups) ? `，分组：${key.groups.join('、')}` : ''}）`
    return `${explainCliClientPolicyFailure(raw)}${used}`
  }

  async function* cliStream(options) {
    // A title is read back as text; progress notes belong to delegated turns.
    const quiet = options?.purpose === 'session-title'
    const blocks = createBlockWriter()
    // Shown at once, so a turn that waits on the CLI never looks idle.
    if (!quiet) yield* blocks.note('▸ 启动 Claude Code CLI…\n')
    let call
    try {
      call = await cliCall(options, { titleModel, cwdOf, modeOf, attachmentsOf, imageLimits })
    } catch (error) {
      yield* blocks.close()
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: String(error?.message ?? error) } } }
      return
    }
    // The CLI may print a finished message more than once as it grows.
    const seen = new Set()
    const firstSighting = key => {
      if (key.endsWith(':')) return true
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }
    let retries = 0
    /** The key this run uses, as the runner described it (never the token). */
    let runKey
    /** Set when the CLI submitted a plan; the turn then ends as DSH's review tool. */
    let submittedPlan
    try {
      let finished
      let lastRequest
      for await (const event of runner.stream({ ...call, signal: options.signal })) {
        switch (event.type) {
          case 'key':
            runKey = event
            if (!quiet) yield* blocks.note(keyNote(event))
            break
          case 'search-bridge':
            if (!quiet) yield* blocks.note(`▸ 网页搜索：Geek2API ${event.backend === 'gpt' ? 'GPT' : 'Claude'}（MCP，原生 WebSearch 已禁用）\n`)
            break
          case 'started':
            if (!quiet) {
              const detail = [event.version, event.model].filter(part => typeof part === 'string' && part !== '').join(' · ')
              yield* blocks.note(`▸ Claude Code CLI 已启动${detail === '' ? '' : `（${detail}）`}\n`)
            }
            break
          case 'retry':
            retries = Math.max(retries, event.attempt ?? retries + 1)
            if (!quiet) yield* blocks.note(`  ↻ ${retryNote(event)}\n`)
            break
          case 'block':
            blocks.boundary(event.kind)
            break
          case 'text':
            yield* blocks.write('text', event.text)
            break
          case 'reasoning':
            yield* blocks.write('reasoning', event.text)
            break
          case 'tool':
            if (firstSighting(`tool:${event.id}`)) yield* blocks.note(`▸ ${event.summary}\n`)
            break
          case 'tool-error':
            if (firstSighting(`error:${event.id}`)) yield* blocks.note(`  ✗ ${event.text === '' ? '失败' : event.text}\n`)
            break
          case 'request-usage':
            lastRequest = event.usage
            break
          case 'plan':
            if (typeof event.plan === 'string' && event.plan !== '') submittedPlan = event.plan
            break
          case 'result':
            finished = event.result
            break
          default:
            break
        }
      }
      if (submittedPlan !== undefined) {
        // This argument persists in the host transcript; delegation recovers
        // only its plan, including the exact single-call PTC program below.
        const review = planReviewCall(options, submittedPlan)
        yield* blocks.toolCall(`plan-${randomUUID()}`, review.name, review.args)
        yield { type: 'usage', usage: turnUsage(lastRequest, finished) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield* blocks.close()
      yield { type: 'usage', usage: turnUsage(lastRequest, finished) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (error) {
      yield* blocks.close()
      const message = await explainFailure(String(error?.message ?? error), runKey, { model: options.model, retries })
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message } } }
    }
  }

  return new (class extends LlmAdapter {
    providerInfo(provider) {
      return inner.providerInfo(provider)
    }

    providerRetryPolicy(provider) {
      return inner.providerRetryPolicy?.(provider)
    }

    listModels(provider) {
      return inner.listModels(provider)
    }

    resolveModel(provider, model, signal) {
      return inner.resolveModel(provider, model, signal)
    }

    async prepareCall(provider, model, signal) {
      if (!cliModels.has(model)) {
        const prepared = await inner.prepareCall(provider, model, signal)
        if (!Object.hasOwn(titleRoutes, model)) return prepared
        // The purpose is only known at dispatch, so the reroute is decided there.
        return {
          ...prepared,
          stream: options => {
            const routed = titleRouteOf(options)
            return routed === undefined ? prepared.stream(options) : reroutedTitle(options, routed)
          },
        }
      }
      const resolved = await inner.resolveModel(provider, model, signal)
      return { model: resolved, stream: options => cliStream(options) }
    }

    stream(options) {
      if (cliModels.has(options.model)) return cliStream(options)
      const routed = titleRouteOf(options)
      return routed === undefined ? inner.stream(options) : reroutedTitle(options, routed)
    }
  })()
}
