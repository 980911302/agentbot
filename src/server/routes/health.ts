import { json } from '../transport/json.js';
import { pickerOptionsFromProviders } from '../../shared/contracts/model-catalog.js';
import type { RouteContext } from './context.js';

export async function handleHealthRoute(
  response: import('node:http').ServerResponse,
  context: RouteContext,
): Promise<void> {
  try {
    const stored = await context.runtime.modelConfigStore.load({ model: context.model });
    json(response, 200, {
      ok: true,
      service: 'agentbot',
      model: stored.model || context.model,
      thinkingEnabled: stored.thinkingEnabled !== false,
      thinkingLevel: stored.thinkingLevel || 'medium',
      models: pickerOptionsFromProviders(stored.providers),
      tools: context.tools,
      budget: context.budget,
      ownerName: context.ownerName,
    });
  } catch {
    json(response, 200, {
      ok: true,
      service: 'agentbot',
      model: context.model,
      models: context.models,
      tools: context.tools,
      budget: context.budget,
      ownerName: context.ownerName,
    });
  }
}
