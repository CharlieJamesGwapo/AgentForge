# Streaming and validated structured output

All three optional model adapters support streaming and schema-constrained generation. The wrapper still requires a configured real model, explicit `--provider`, `permissions.allowNetwork=true` and `--approve-network`. There are no implicit retries, provider substitutions or model downloads. Core status/doctor commands remain offline.

## Stream text

```sh
agentforge prompt --model --provider ollama --task "Explain this requirement in three lines" --stream --approve-network
```

`--stream` emits JSON Lines in both normal and `--json` mode. A text event is `{ "provider": "ollama", "type": "text-delta", "text": "...", "provisional": true }`. The terminal event is `{ "provider": "ollama", "type": "complete", "result": { ... } }` with the same result shape as ordinary model requests.

Text events are provisional. Require a terminal event and inspect `finishReason`; a disconnected or malformed stream is not successful completion. Errors use JSON on stderr and a nonzero exit. Cancellation exits 5; partial/refused terminal results exit 4. Earlier provisional text can remain on stdout after a later failure.

Sanitization deliberately emits complete lines rather than individual tokens. A final line without a newline is emitted only at completion. Credential introducers split across lines and private-key blocks are retained until they can be redacted safely. This can delay output, especially if the model produces one long line. The selected credential is redacted even when split across wire chunks. Redaction remains best effort; never include secrets in task text or schema.

Native protocols are SSE for OpenAI Responses and Anthropic Messages, and NDJSON for Ollama. Parsing handles fragmented UTF-8, LF/CRLF/CR framing, comments, multiple records per chunk and final NDJSON records without a newline. Each codec requires its actual terminal event. The shared deadline spans the entire active HTTP request/body, not each individual chunk. The response remains capped at 1 MiB and 10000 parsed events. Breaking an adapter iterator closes its active request.

## Request validated JSON

From this checkout, use the [example schema](../../examples/answer.schema.json):

```sh
node dist/cli/index.js prompt --model --provider ollama --task "Return an answer and your confidence" --schema examples/answer.schema.json --approve-network
```

Add `--stream` to use the native streaming protocol. Structured streams withhold all text deltas until the terminal JSON has been validated. A successful result includes `structured: { "status": "valid", "data": ... }`, and `text` is the JSON serialization of that delivered data. No JSON repair, Markdown-fence stripping, type coercion, default insertion or extra-property removal occurs.

Schema files must be inside the selected project and use a safe relative path; symlinks and traversal are rejected. In an installed package or another project, copy an appropriate schema into that project's root and pass its relative path. The schema is explicitly sent with your task, including property names, enum values and descriptions. Do not include secrets or personal data in it.

The raw JSON must validate, then redaction is applied to the parsed values, then the exact delivered data is validated again. If redaction changes an enum/type contract, generation fails rather than returning an invalid value as valid. Invalid model JSON or a schema mismatch exits 4 with a safe diagnostic and no invalid payload. Refusal or length-limited output instead includes `structured: { "status": "unavailable", "reason": "refusal" }` (or `length`), never validated data, and exits 4.

## Portable schema subset

A deliberately bounded JSON Schema 2020-12 subset is validated locally with Ajv. These are the only accepted keywords:

- `type`: object, array, string, number, integer, boolean or null; a two-type union must include null.
- `properties`, `required`, `additionalProperties`: every object must list all its properties in `required` and set `additionalProperties: false`.
- `items`: a single item schema for arrays.
- `enum`: a non-empty list of scalar JSON values.
- `description`: a bounded explanatory string.

The root must be an object. Schemas are capped at 64 KiB, depth 12, 256 schema nodes, 64 properties per object and 128 enum entries. Prototype-sensitive property names are rejected. Output traversal is capped at depth 64 and 50000 data nodes. Numbers use JavaScript JSON number semantics.

References, recursive schemas, remote schemas, regex, formats, combinators, defaults and numeric/string length constraints are rejected before any request. This avoids pretending that the three providers accept identical full-schema dialects. No unsupported keyword is silently stripped or weakened. Upstream model/endpoint limitations can still reject an otherwise accepted portable schema; no fallback occurs. Local validation is authoritative for returned data.

## Native request fields and evidence

OpenAI uses `text.format: {type: "json_schema", name: "agentforge_output", strict: true, schema}`; Anthropic uses `output_config.format: {type: "json_schema", schema}`; Ollama uses `format: schema`. These follow the official [OpenAI structured output](https://developers.openai.com/api/docs/guides/structured-outputs), [Anthropic structured output](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) and [Ollama schema](https://docs.ollama.com/capabilities/structured-outputs) protocols.

Local HTTP contract tests exercise all three implementations, including streaming plus validation. They do not establish access to any live account, model, hosted endpoint or installed daemon. [Tool execution](tool-invocation.md) requires separate exact approval; optional [built-in orchestration](../features/orchestration.md) schedules bounded conversations. Generated output is never automatically executed or applied to source files.
