import type { ServerResponse } from 'node:http';
import { json } from '../transport/index.js';
import type { RouteContext } from './context.js';

/** /api/secrets：只暴露名字，永远不回传值 */
export function handleSecretsCollection(response: ServerResponse, context: RouteContext): void {
  void context.runtime.secrets
    .names()
    .then((names) => json(response, 200, { names }))
    .catch(() => json(response, 200, { names: [] }));
}
