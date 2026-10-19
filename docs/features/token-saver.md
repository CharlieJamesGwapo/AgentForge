# TokenSaver

`agentforge prompt --task '<text>' --compact` removes exact consecutive duplicate prose lines outside Markdown code fences. It preserves all distinct lines and code blocks; it does not summarize, paraphrase or discard instructions. Inspect the returned text before replacing the original.

Reports include original/optimized character counts, removed lines, and token estimates calculated as `ceil(characters / 4)`. Characters are Unicode code points. This is a crude estimate whose error varies substantially by language and tokenizer; it is not billed usage. No savings percentage is advertised. The engine accepts empty text; the CLI requires a non-empty task.

The bundled TokenSaver skill additionally guides context selection and constraint preservation by a human or agent. That reasoning is not performed by this deterministic command. [Benchmark methodology](../benchmarks/methodology.md) describes reproducible examples.
