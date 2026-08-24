import type { CharacterSkillAction, CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'

import type {
  CharacterSkillActionProposal,
  CharacterSkillAdapter,
  CharacterSkillExecutionContext,
  CharacterSkillExecutionResult,
  CharacterSkillMatchContext,
} from './skill-adapter.js'

export const WEB_RESEARCH_SKILL = 'web-research.firecrawl'
export const FIRECRAWL_ADAPTER_ID = 'builtin.firecrawl'
export const FIRECRAWL_CREDENTIAL_ID = 'integration.firecrawl'

const REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_BASE_URL = 'https://api.firecrawl.dev/v2'
const MAX_DETAIL_CHARS = 4_000
const MAX_TARGET_CHARS = 300
const SEARCH_RESULT_LIMIT = 5

const DESCRIPTOR: CharacterSkillDescriptor = {
  id: WEB_RESEARCH_SKILL,
  displayName: 'Firecrawl 网络研究',
  summary: '通过宿主配置的 Firecrawl 执行真实网页搜索与抓取，并把带来源链接的结果回填给角色；API Key 只保存在本机加密凭据库，不进入角色、Prompt 或动作记录。',
  adapterId: FIRECRAWL_ADAPTER_ID,
  risks: ['read', 'external-side-effect'],
  supportsScheduling: false,
}

export interface FirecrawlSkillAdapterOptions {
  /** Returns the locally stored Firecrawl API key, if the user configured one. */
  resolveApiKey?: () => Promise<string | undefined> | string | undefined
  baseUrl?: string
  fetch?: typeof globalThis.fetch
}

interface SearchHit {
  title?: string
  url?: string
  description?: string
}

export class FirecrawlSkillAdapter implements CharacterSkillAdapter {
  readonly id = FIRECRAWL_ADAPTER_ID
  readonly descriptors = [DESCRIPTOR] as const
  readonly #resolveApiKey: () => Promise<string | undefined> | string | undefined
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  constructor(options: FirecrawlSkillAdapterOptions = {}) {
    this.#resolveApiKey = options.resolveApiKey ?? (() => undefined)
    this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  propose(context: CharacterSkillMatchContext): CharacterSkillActionProposal[] {
    if (!context.grantedSkillIds.includes(WEB_RESEARCH_SKILL)) return []
    return webResearchIntents(context.prompt).map((intent) => ({
      skillId: WEB_RESEARCH_SKILL,
      adapterId: this.id,
      action: intent.action,
      target: intent.target,
      label: intent.label,
      risk: 'external-side-effect' as const,
      authorization: 'explicit-user-request' as const,
      parameters: {},
    }))
  }

  async execute(
    action: CharacterSkillAction,
    context: CharacterSkillExecutionContext,
  ): Promise<CharacterSkillExecutionResult> {
    const apiKey = await this.#resolveApiKey()
    if (apiKey === undefined || apiKey.trim() === '') {
      return {
        status: 'waiting-for-integration',
        detail: '尚未配置 Firecrawl API Key：请在「设置 → 集成」中填写并保存后重试。本次没有伪造任何搜索或抓取结果。',
      }
    }

    const path = action.action === 'firecrawl.scrape'
      ? '/scrape'
      : action.action === 'firecrawl.search'
        ? '/search'
        : undefined
    if (path === undefined) return { status: 'failed', detail: `未知的 Firecrawl 动作：${action.action}` }

    const payload = path === '/scrape'
      ? { url: action.target, formats: ['markdown'] }
      : { query: action.target, limit: SEARCH_RESULT_LIMIT }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!response.ok) {
        return { status: 'failed', detail: firecrawlFailureDetail(response.status) }
      }
      const payloadJson = await response.json() as { data?: unknown }
      return path === '/scrape'
        ? scrapeResult(action.target, payloadJson)
        : searchResult(payloadJson)
    } catch (error) {
      void context?.now
      return {
        status: 'outcome-unknown',
        detail: error instanceof Error && error.name === 'AbortError'
          ? 'Firecrawl 请求超时，结果未知；不得自动重试或编造内容'
          : 'Firecrawl 连接中断，结果未知；不得自动重试或编造内容',
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

interface ResearchIntent {
  action: 'firecrawl.search' | 'firecrawl.scrape'
  target: string
  label: string
}

/** Extracts explicit research intents; never guesses on ambiguous prompts. */
export function webResearchIntents(prompt: string): ResearchIntent[] {
  const intents: ResearchIntent[] = []
  const trimmed = prompt.trim()
  if (trimmed.length === 0) return intents

  const urls = prompt.match(/https?:\/\/[^\s，。；：、！？）】》"']+/g) ?? []
  if (urls.length > 0 && /抓取|读取|打开|总结|提取|要点|正文|网页|页面|链接/.test(prompt)) {
    for (const url of urls.slice(0, 1)) {
      intents.push({ action: 'firecrawl.scrape', target: url, label: `抓取网页 ${shortUrl(url)}` })
    }
    return intents
  }

  const searchMatch = /(?:帮我|请|先)?(?:联网)?(搜索|搜一下|查一下|查查|检索|上网查)(?:一下)?[:：，、\s]*(.{2,200})/.exec(trimmed)
  if (searchMatch !== null) {
    const query = searchMatch[2]!.split(/[。；！？\n]/)[0]!.trim()
    if (query.length >= 2) {
      intents.push({ action: 'firecrawl.search', target: truncate(query, MAX_TARGET_CHARS), label: `联网搜索「${truncate(query, 40)}」` })
    }
  }
  return intents
}

function scrapeResult(url: string, payload: { data?: unknown }): CharacterSkillExecutionResult {
  const data = asRecord(payload.data)
  const markdown = typeof data?.markdown === 'string' ? data.markdown.trim() : ''
  if (markdown.length === 0) {
    return { status: 'failed', detail: `Firecrawl 抓取了 ${url}，但页面没有返回可用正文（可能是反爬或空页面）` }
  }
  const title = typeof data?.metadata === 'object' && data.metadata !== null
    ? asRecord(data.metadata)?.title
    : undefined
  const heading = typeof title === 'string' && title.trim().length > 0 ? `《${title.trim()}》` : ''
  const clipped = markdown.length > MAX_DETAIL_CHARS
    ? `${markdown.slice(0, MAX_DETAIL_CHARS)}…（正文共 ${markdown.length} 字符，已截断）`
    : markdown
  return {
    status: 'executed',
    detail: `已通过 Firecrawl 抓取 ${heading ? `${heading} ` : ''}${url}\n来源：${url}\n正文（Markdown）：\n${clipped}`,
  }
}

function searchResult(payload: { data?: unknown }): CharacterSkillExecutionResult {
  const hits = Array.isArray(payload.data) ? payload.data.map(asRecord).filter((h) => h !== undefined) : []
  const usable = hits.filter((hit) => typeof hit.url === 'string').slice(0, SEARCH_RESULT_LIMIT)
  if (usable.length === 0) {
    return { status: 'executed', detail: 'Firecrawl 搜索完成，但没有返回可用结果；请如实在回复中说明，不要编造来源。' }
  }
  const lines = usable.map((hit, index) => {
    const title = typeof hit.title === 'string' && hit.title.trim().length > 0 ? hit.title.trim() : '(无标题)'
    const description = typeof hit.description === 'string' && hit.description.trim().length > 0
      ? `\n   摘要：${truncate(hit.description.trim(), 200)}`
      : ''
    return `${index + 1}. ${title}\n   链接：${String(hit.url)}${description}`
  })
  return {
    status: 'executed',
    detail: `已通过 Firecrawl 完成联网搜索，返回 ${usable.length} 条结果（引用时必须保留链接）：\n${lines.join('\n')}`,
  }
}

function firecrawlFailureDetail(status: number): string {
  if (status === 401 || status === 403) return `Firecrawl 拒绝了请求（HTTP ${status}）：API Key 无效或无权限，请在「设置 → 集成」更新后重试`
  if (status === 402) return `Firecrawl 返回 HTTP 402：额度不足，请前往 firecrawl.dev 检查套餐`
  if (status === 429) return `Firecrawl 返回 HTTP 429：触发限流，请稍后再试`
  return `Firecrawl 返回 HTTP ${status}，请求被拒绝`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host + parsed.pathname
  } catch {
    return url
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}
