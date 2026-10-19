# Prompt benchmark methodology

Run `npm run benchmark` from the checkout. The local fixture set includes exact duplicate prose, unique constraints, fenced code and multilingual text. Record input/output character counts, the exact `ceil(characters / 4)` estimate method and content removed. The script verifies expected preservation rather than claiming semantic model quality.

Character counts are Unicode code points, not graphemes or exact model tokens. No provider tokenizer, billing API or AI quality evaluation is used. Do not extrapolate these toy fixtures into general savings percentages. Representative project workloads and a documented exact tokenizer are future work.
