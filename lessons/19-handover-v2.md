# 19 — writing the handover

## Pricing a "before" claim without checking the tag out

`git show v1.0.0:<path>` and `git grep <pattern> v1.0.0 -- <paths>` answer "what did this cost at
the baseline" in one command each. The plan said "~14 edits across 4 files"; the tag has 17
slug-bearing literals in AppHost B alone. Count it, do not repeat it.

## `.stack/*.json` on disk is not evidence that a stack is up

They survive `aspire stop` and nothing removes them. `ss -ltn | grep :28080` and `docker ps` are
the questions that mean what you meant. The same trap costs the e2e suite a 90-second timeout,
because `global-setup.ts`'s fast-fail branch keys on `url === ''` and is unreachable after the
first run.

## `VAR=x ( cd … && … )` is a bash syntax error

Not a quoting subtlety — `bash: syntax error near unexpected token '('`. It was the documented way
to run this stack on a real issuer in `docs/MORNING.md` §1 and had clearly never been pasted.
`export` first, or `env VAR=x bash -c '…'`. Check every command block you are told is the
documented path by running it, or at least by parsing it (`bash -n`).

## Mint doc labels from the registry, not from memory

This repo points at findings by two-letter label across five files. Before adding any:

```bash
grep -ohE '\*\*[A-Z]{2}[0-9]?\*\*' docs/*.md README.md REQUIREMENTS.md | sort -u
```

`FE` and `FI` were the highest in use, so the acceptance run's nine findings became `FJ`–`FR`.
Severity numbers from a review are not durable references — they are ordered by that review.

## A verdict's own cross-references may not exist in the repo

The acceptance text cited "acceptance items 4, 5 and 6" and "acceptance step 2". There is no
acceptance list in the repo, so copying those numbers into a doc leaves a reader nothing to
follow. Name the claim instead.

## Line numbers in a review go stale the moment you fix one

The verdict cited `README.md:197`, `:210`, `:439-443`, `REQUIREMENTS.md:88`. The first edit moves
the rest. Match on the sentence with `python3` + `str.replace` and an `assert … in s`, so a hunk
that does not match fails loudly rather than landing somewhere else.
