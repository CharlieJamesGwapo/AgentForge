# Optional model providers

Requires the built checkout or `npm run dev -- <command>`. The examples use the CLI name `agentforge`; the equivalent built invocation is `node dist/cli/index.js`.

## Configure and inspect

Choose one provider and a real model accessible to your account or installed Ollama instance. `YOUR_MODEL_ID` below is a placeholder that you must replace, not an advertised model.

```sh
agentforge config set providers '[{"id":"openai","model":"YOUR_MODEL_ID","maxOutputTokens":1024}]'
agentforge provider list
agentforge provider check openai
```

For Anthropic use `id: anthropic`; for Ollama use `id: ollama`. You may configure all three with unique ids, but must select one explicitly per request. Setting `providers` replaces the whole array; preserve other entries you want to keep.

OpenAI reads `OPENAI_API_KEY`; Anthropic reads `ANTHROPIC_API_KEY`. Set the relevant environment variable through your trusted shell or secret-management tooling. Do not put its value in config, command arguments, source files or reports. Optional `apiKeyEnv` selects a different variable ending in `_KEY` or `_TOKEN`; it is a reference, never the credential itself. Missing explicit credentials never fall back to another variable.

Ollama defaults to `http://localhost:11434` and needs no key. An explicitly configured Ollama `apiKeyEnv` becomes required and is sent as a Bearer credential. A real daemon and preinstalled model are prerequisites for actual inference; the toolkit never starts or installs either.

Provider entry settings:

| Key             | Meaning                                                          |
| --------------- | ---------------------------------------------------------------- |
| id              | `openai`, `anthropic`, or `ollama`; unique per entry             |
| model           | Required real upstream model id; no default                      |
| baseUrl         | Optional explicitly trusted endpoint prefix                      |
| apiKeyEnv       | Optional credential environment name ending `_KEY` or `_TOKEN`   |
| maxOutputTokens | Integer 1–32768, default 1024; upstream model limits still apply |

Default endpoint prefixes are `https://api.openai.com/v1`, `https://api.anthropic.com/v1` and `http://localhost:11434`. Custom endpoints require HTTPS except strict loopback HTTP. User info, query strings and fragments are rejected, and redirects are never followed. Configuring a custom hosted endpoint authorizes sending the chosen provider credential there when you approve a request; verify who controls it.

## Explicit network use

```sh
agentforge config set permissions.allowNetwork true
agentforge provider check openai --connect --approve-network
agentforge prompt --model --provider openai --task "Explain this explicit requirement" --approve-network
```

The connection command sends no task or inference request. Hosted checks validate the model-list response shape but do not guarantee access to the configured generation model. Ollama checks installed tags, treating an untagged model name as `:latest` for its availability check only.

Without both permission and invocation approval, no request is sent. Offline diagnostics do not prove credentials are valid or an endpoint is reachable. There is no silent provider selection, model substitution, automatic retry or failover. A timed-out/cancelled HTTP request can still have been processed by a remote service; client cancellation is not a billing guarantee. Output limits cap returned data, not monetary cost or input tokens.

`--timeout-ms <integer>` is 1–300000 ms (generation default 60000, connection default 10000), covering headers and body reads. The response is capped at 1 MiB. Ctrl+C cancels the request. HTTP 401/403, 429, connection failures and malformed replies get safe normalized errors without response bodies. There is no raw-error mode that exposes server diagnostics.

## Output and limitations

`--task` text is transmitted verbatim; an explicitly selected `--schema` is also sent. Repository files, checkpoints, environment values other than the selected authentication credential, and skill procedures are not attached. Returned text is printed after best-effort secret redaction; it is never applied or executed.

`finishReason: completed` exits 0. `length` and `refusal` preserve the result for review and exit 4. Missing/malformed text or unknown completion states fail explicitly. Native `usage` counters are returned only when valid; absence is `unavailable`. Exact usage is distinct from local TokenSaver estimates. API response model names are reported as received; servers can resolve aliases to concrete models.

The implementations support ordinary text, native streaming, a validated portable structured-output subset and ordinary/streaming client function calls. The adapters never execute tools; the independent execution engine requires exact explicit batch approval. See [streaming and schemas](streaming-structured.md) and [tool invocation](tool-invocation.md). Optional [built-in orchestration](../features/orchestration.md) schedules bounded provider conversations; external coding-host agent dispatch is unavailable. [File application](project-edits.md) fails closed on the current backend. A provider may reject a model-specific parameter or require additional capabilities; such failures are reported rather than silently changing the request. Tests use local HTTP fixtures, not live provider accounts or a real Ollama installation.
