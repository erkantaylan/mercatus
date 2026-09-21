# diary/

One file per agent task, written **after** the work, whether it succeeded or failed.

**Filename:** `<NN>-<task-slug>.md` — `NN` is the task number, zero-padded, never reused.
Example: `03-store-api-products.md`.

**What goes in it:** what you did, what you changed, and the state you left behind. Factual and
short. The next agent reads this to know where the build actually is, as opposed to where
`BUILD-PLAN.md` says it should be.

Suggested shape:

```markdown
# NN — task slug

**Status:** done | partial | failed
**Gate:** the command you ran, and what it printed

## What I built
Files added or changed, grouped by package.

## What works
Verified by running it, not by reading it.

## What does not work yet
Named, so the next agent does not rediscover it.

## State left behind
Containers running, ports bound, migrations applied, anything half-finished.
```

**The diary is history. It is never edited by a later agent.** If a later task invalidates
something written here, that later task's own diary entry says so.

For "things that would have saved me time", write to `../lessons/` instead — that file is read by
every agent after you, and the diary is not.
