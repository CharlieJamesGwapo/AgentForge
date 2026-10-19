export type RefinedPrompt = { prompt: string; assumptions: string[] };

/** Build a reusable engineering brief while keeping the original request intact. */
export function refinePrompt(input: string): RefinedPrompt {
  if (typeof input !== 'string') {
    throw new TypeError('Prompt input must be a string.');
  }

  const objective = input.trim();
  if (objective.length === 0) {
    throw new Error('Prompt input must not be empty.');
  }

  const assumptions = [
    'Repository structure and conventions are unknown until they are inspected.',
  ];
  const prompt = [
    'Objective',
    objective,
    '',
    'Context',
    'Inspect the repository and current project guidance before choosing implementation details.',
    '',
    'Scope',
    'Make the changes needed to meet the objective and keep unrelated work out of scope.',
    '',
    'Constraints',
    '- Preserve the request’s intent and existing behavior outside the requested scope.',
    '- Separate confirmed repository facts from assumptions; do not invent requirements.',
    '',
    'Implementation plan',
    '1. Inspect relevant code, configuration, and existing conventions.',
    '2. Implement the smallest complete change that meets the objective.',
    '3. Review the diff for unrelated changes and sensitive data.',
    '',
    'Acceptance criteria',
    '- The requested behavior is implemented and existing relevant behavior is preserved.',
    '- Any assumptions or unresolved questions that affect the result are reported.',
    '',
    'Testing plan',
    '- Run the checks relevant to the changed behavior and report their actual results.',
    '',
    'Risks',
    '- Repository-specific risks are unknown until the relevant code and configuration are inspected.',
    '',
    'Unresolved questions',
    '- Raise only questions that block a correct implementation; otherwise proceed using repository evidence.',
  ].join('\n');

  return { prompt, assumptions };
}

export type CompactedPrompt = {
  text: string;
  originalCharacters: number;
  optimizedCharacters: number;
  originalTokenEstimate: number;
  optimizedTokenEstimate: number;
  method: string;
  removedLines: number;
};

/** Remove exact adjacent duplicate lines outside Markdown fenced code blocks. */
export function compactPrompt(input: string): CompactedPrompt {
  if (typeof input !== 'string') {
    throw new TypeError('Prompt input must be a string.');
  }

  const lines = input.split(/(?<=\n)|(?<=\r)(?!\n)/);
  const output: string[] = [];
  let inFence = false;
  let fenceCharacter = '';
  let fenceLength = 0;
  let removedLines = 0;

  for (const line of lines) {
    const content = line.replace(/(?:\r\n|\n|\r)$/, '');
    const fence = content.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence !== null) {
      const marker = fence[1] ?? '';
      const markerCharacter = marker[0] ?? '';
      if (!inFence) {
        inFence = true;
        fenceCharacter = markerCharacter;
        fenceLength = marker.length;
      } else if (
        markerCharacter === fenceCharacter &&
        marker.length >= fenceLength &&
        content.trim() === marker
      ) {
        inFence = false;
        fenceCharacter = '';
        fenceLength = 0;
      }
      output.push(line);
      continue;
    }

    const previous = output.at(-1);
    const previousContent = previous?.replace(/(?:\r\n|\n|\r)$/, '');
    if (!inFence && previousContent === content) {
      removedLines += 1;
      continue;
    }
    output.push(line);
  }

  const text = output.join('');
  const characterCount = (value: string): number => Array.from(value).length;
  const estimate = (value: string): number =>
    Math.ceil(characterCount(value) / 4);
  return {
    text,
    originalCharacters: characterCount(input),
    optimizedCharacters: characterCount(text),
    originalTokenEstimate: estimate(input),
    optimizedTokenEstimate: estimate(text),
    method:
      'Removed exact consecutive duplicate lines outside fenced code; character counts use Unicode code points and token estimates use ceil(characters / 4).',
    removedLines,
  };
}
