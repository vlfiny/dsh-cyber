import type { ModelCredentialService } from '../services/model-credential-service.js'

import { HttpError } from '../http/errors.js'
import { readJson, requiredString } from '../http/request.js'
import { writeJson } from '../http/response.js'
import type { Router } from '../http/router.js'
import {
  FIRECRAWL_ADAPTER_ID,
  FIRECRAWL_CREDENTIAL_ID,
  FirecrawlSkillAdapter,
  WEB_RESEARCH_SKILL,
} from '../skills/firecrawl-adapter.js'

export interface IntegrationRoutesDependencies {
  credentials: ModelCredentialService
}

const KEY_PATTERN = /^fc-[A-Za-z0-9_-]{10,}$/
const TEST_TARGET = 'https://example.com/'

export function registerIntegrationRoutes(
  router: Router,
  dependencies: IntegrationRoutesDependencies,
): void {
  const { credentials } = dependencies
  const adapter = new FirecrawlSkillAdapter({
    resolveApiKey: () => credentials.resolve(FIRECRAWL_CREDENTIAL_ID),
  })

  router.get(/^\/api\/integrations\/firecrawl$/, ({ response }) => {
    writeJson(response, 200, {
      integration: 'firecrawl',
      skillId: WEB_RESEARCH_SKILL,
      adapterId: FIRECRAWL_ADAPTER_ID,
      configured: credentials.has(FIRECRAWL_CREDENTIAL_ID),
    })
  })

  // The key is stored in the local encrypted vault (same seam as model keys);
  // it is never echoed back, never written to SQLite, and never logged.
  router.put(/^\/api\/integrations\/firecrawl\/key$/, async ({ request, response }) => {
    const body = await readJson(request)
    const apiKey = requiredString(body, 'apiKey').trim()
    if (!KEY_PATTERN.test(apiKey)) {
      throw new HttpError(422, 'invalid_firecrawl_key', 'Firecrawl API Key 需要以 fc- 开头且只包含字母、数字、下划线或连字符')
    }
    await credentials.set(FIRECRAWL_CREDENTIAL_ID, apiKey)
    writeJson(response, 200, { configured: true })
  })

  router.delete(/^\/api\/integrations\/firecrawl\/key$/, async ({ response }) => {
    await credentials.delete(FIRECRAWL_CREDENTIAL_ID)
    writeJson(response, 200, { configured: false })
  })

  // Real smoke test against the configured key; returns the adapter's own
  // outcome wording so the UI never fabricates a success the provider denied.
  router.post(/^\/api\/integrations\/firecrawl\/test$/, async ({ request, response }) => {
    if (!credentials.has(FIRECRAWL_CREDENTIAL_ID)) {
      throw new HttpError(409, 'firecrawl_not_configured', '请先填写并保存 Firecrawl API Key')
    }
    let target = TEST_TARGET
    try {
      const body = await readJson(request)
      const url = body.url
      if (typeof url === 'string' && /^https?:\/\/\S+$/.test(url.trim())) target = url.trim()
    } catch {
      // empty body is fine for the smoke test
    }
    const result = await adapter.execute({
      id: 'integration-smoke-test',
      worldId: 'integration',
      characterId: 'integration',
      skillId: WEB_RESEARCH_SKILL,
      adapterId: FIRECRAWL_ADAPTER_ID,
      action: 'firecrawl.scrape',
      target,
      label: `抓取网页 ${target}`,
      risk: 'external-side-effect',
      authorization: 'explicit-user-request',
      parameters: {},
      status: 'waiting-for-integration',
      detail: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { now: new Date() })
    writeJson(response, 200, { ok: result.status === 'executed', ...result })
  })
}
