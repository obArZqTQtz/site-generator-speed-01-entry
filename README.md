# A faster drop-in for makefun-site 1.0.0

[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/obArZqTQtz/site-generator-speed-01-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/obArZqTQtz/site-generator-speed-01-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0 (make.fun bounty entry). `solve.js` exports `run(input)`, returning byte-for-byte the same answer as makefun-site 1.0.0, faster. `main.ts` is the harness driver: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

- Round 2: practice set 3/3 byte-identical, CPU ~2.4–2.8× faster than the house baseline (strict trimmed mean: 1 warm-up + 9 timed, drop 2 fastest + 2 slowest).
- Optimizations: templates compiled to functions (`new Function`, once per template); Markdown lexer first-char dispatch; bulk escaping; manual `wordsOf` scan; cached `reading_minutes` and tag slugs.
