import { describe, expect, it } from 'vitest'

import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'

import {
  FIRECRAWL_ADAPTER_ID,
  FirecrawlSkillAdapter,
  WEB_RESEARCH_SKILL,
} from '../src/skills/firecrawl-adapter.js'
import { createBuiltinSkillRegistry } from '../src/skills/builtin-skill-registry.js'

function context(prompt: string, granted = true) {
  return {
    worldId: 'world-1',
    characterId: 'character-1',
    prompt,
    grantedSkillIds: granted ? [WEB_RESEARCH_SKILL] : [],
    now: new Date('2026-08-24T08:00:00.000Z'),
  }
}

function action(target: string, kind: 'firecrawl.search' | 'firecrawl.scrape' = 'firecrawl.search'): CharacterSkillAction {
  return {
    id: 'action-1',
    worldId: 'world-1',
    characterId: 'character-1',
    skillId: WEB_RESEARCH_SKILL,
    adapterId: FIRECRAWL_ADAPTER_ID,
    action: kind,
    target,
    label: '测试动作',
    risk: 'external-side-effect',
    authorization: 'explicit-user-request',
    parameters: {},
    status: 'waiting-for-integration',
    detail: '',
    createdAt: '2026-08-24T08:00:00.000Z',
    updatedAt: '2026-08-24T08:00:00.000Z',
  }
}

function jsonResponder(status: number, payload: unknown) {
  return (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof globalThis.fetch
}

describe('FirecrawlSkillAdapter', () => {
  it('is registered by the builtin registry', () => {
    const registry = createBuiltinSkillRegistry()
    const descriptors = registry.list()
    expect(descriptors.some((descriptor) => descriptor.id === WEB_RESEARCH_SKILL)).toBe(true)
  })

  it('proposes a search action for explicit search intents and nothing for unrelated prompts', async () => {
    const adapter = new FirecrawlSkillAdapter()
    const proposals = await adapter.propose(context('帮我搜索 DeepSeek Harness 的最新版本，并总结变化'))
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({
      skillId: WEB_RESEARCH_SKILL,
      adapterId: FIRECRAWL_ADAPTER_ID,
      action: 'firecrawl.search',
    })
    expect(proposals[0]!.target).toContain('DeepSeek Harness')

    expect(await adapter.propose(context('今天天气不错'))).toEqual([])
    // 未授权技能时绝不提议
    expect(await adapter.propose(context('帮我搜索 DeepSeek Harness', false))).toEqual([])
  })

  it('proposes a scrape action when a URL appears with an extraction verb', async () => {
    const adapter = new FirecrawlSkillAdapter()
    const proposals = await adapter.propose(context('抓取 https://docs.example.com/guide 这个页面的要点'))
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ action: 'firecrawl.scrape', target: 'https://docs.example.com/guide' })
  })

  it('reports a waiting outcome instead of fabricating results when no key is configured', async () => {
    const adapter = new FirecrawlSkillAdapter({ resolveApiKey: () => undefined })
    const result = await adapter.execute(action('DeepSeek Harness'), { now: new Date() })
    expect(result.status).toBe('waiting-for-integration')
    expect(result.detail).toContain('尚未配置 Firecrawl API Key')
  })

  it('executes a real search and carries sources into the detail', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const fetchMock = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      seenUrl = String(input)
      seenAuth = init?.headers?.Authorization ?? ''
      return new Response(JSON.stringify({
        data: [
          { title: 'DeepSeek Harness 发布', url: 'https://example.com/a', description: '首个稳定版' },
          { title: '指南', url: 'https://example.com/b' },
        ],
      }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const adapter = new FirecrawlSkillAdapter({ resolveApiKey: () => 'fc-test-key', fetch: fetchMock })
    const result = await adapter.execute(action('DeepSeek Harness 最新版本'), { now: new Date() })

    expect(seenUrl).toContain('https://api.firecrawl.dev/v2/search')
    expect(seenAuth).toBe('Bearer fc-test-key')
    expect(result.status).toBe('executed')
    expect(result.detail).toContain('DeepSeek Harness 发布')
    expect(result.detail).toContain('https://example.com/a')
  })

  it('executes a scrape and truncates very large pages', async () => {
    const markdown = 'x'.repeat(9_000)
    const adapter = new FirecrawlSkillAdapter({
      resolveApiKey: () => 'fc-test-key',
      fetch: (async () => new Response(JSON.stringify({ data: { markdown, metadata: { title: '示例页面' } } }), { status: 200 })) as unknown as typeof globalThis.fetch,
    })
    const result = await adapter.execute(action('https://example.com/big', 'firecrawl.scrape'), { now: new Date() })
    expect(result.status).toBe('executed')
    expect(result.detail).toContain('《示例页面》')
    expect(result.detail).toContain('已截断')
    expect(result.detail.length).toBeLessThan(markdown.length)
  })

  it('turns credential rejections into an actionable failure and keeps timeouts ambiguous', async () => {
    const unauthorized = new FirecrawlSkillAdapter({
      resolveApiKey: () => 'fc-stale',
      fetch: (async () => new Response('denied', { status: 401 })) as unknown as typeof globalThis.fetch,
    })
    const denied = await unauthorized.execute(action('query'), { now: new Date() })
    expect(denied.status).toBe('failed')
    expect(denied.detail).toContain('401')
    expect(denied.detail).toContain('设置 → 集成')

    const aborting = new FirecrawlSkillAdapter({
      resolveApiKey: () => 'fc-test-key',
      fetch: (async () => {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        throw error
      }) as unknown as typeof globalThis.fetch,
    })
    const timeout = await aborting.execute(action('query'), { now: new Date() })
    expect(timeout.status).toBe('outcome-unknown')
    expect(timeout.detail).toContain('不得自动重试')
  })
})
