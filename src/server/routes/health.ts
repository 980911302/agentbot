import { json } from '../transport/json.js';
import type { RouteContext } from './context.js';

export function handleHealthRoute(response: import('node:http').ServerResponse, context: RouteContext): void {
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
