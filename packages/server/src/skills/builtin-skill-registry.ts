import { FirecrawlSkillAdapter, type FirecrawlSkillAdapterOptions } from './firecrawl-adapter.js'
import { HomeAssistantSkillAdapter, type HomeAssistantSkillAdapterOptions } from './home-assistant-adapter.js'
import { CharacterSkillAdapterRegistry } from './skill-adapter.js'

export interface BuiltinSkillRegistryOptions {
  homeAssistant?: HomeAssistantSkillAdapterOptions
  firecrawl?: FirecrawlSkillAdapterOptions
}

/**
 * Host composition root for trusted skill adapters.
 * Adding an adapter never changes CharacterSkillRuntime or the Agent loop.
 */
export function createBuiltinSkillRegistry(
  options: BuiltinSkillRegistryOptions = {},
): CharacterSkillAdapterRegistry {
  const registry = new CharacterSkillAdapterRegistry()
  registry.register(new HomeAssistantSkillAdapter(options.homeAssistant))
  registry.register(new FirecrawlSkillAdapter(options.firecrawl))
  return registry
}
