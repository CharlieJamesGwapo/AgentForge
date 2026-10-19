import { cloneToolJson } from '../adapters/tools.js';
import { prepareResultSchema } from '../adapters/tool-results.js';
import { AgentForgeError } from '../shared/errors.js';
import type { RegisteredTool } from '../engines/tools.js';
/** Apply local result contracts without mutating the registered tool definitions. */
export function applyResultSchemas(
  tools: readonly RegisteredTool[],
  value: unknown,
): RegisteredTool[] {
  let input: unknown;
  try {
    input = cloneToolJson(value, 256 * 1024);
  } catch {
    throw new AgentForgeError('Result schemas must be bounded JSON data.', 2);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AgentForgeError(
      'Result schemas must be a JSON object mapping registered tool names to schemas.',
      2,
    );
  const entries = Object.entries(input);
  const names = new Set(tools.map((tool) => tool.definition.name));
  if (
    !entries.length ||
    entries.length > 16 ||
    entries.some(([name]) => !names.has(name))
  )
    throw new AgentForgeError(
      'Result schemas must contain 1–16 registered tool names only.',
      2,
    );
  const schemas = new Map(
    entries.map(([name, schema]) => [name, prepareResultSchema(schema)]),
  );
  return tools.map((tool) => ({
    ...tool,
    definition: {
      ...tool.definition,
      ...(schemas.has(tool.definition.name)
        ? { resultSchema: schemas.get(tool.definition.name)! }
        : {}),
    },
  }));
}
