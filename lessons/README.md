# lessons/

**Every agent reads every file in this directory before writing any code.** That is the deal.
It only works if what is here is worth the read.

**Filename:** `<NN>-<task-slug>.md`, matching the diary entry for the same task.

## What belongs here

Only things that would have saved *you* time if you had known them before you started:

- exact versions that work together, and pairs that do not
- a command that worked, and the obvious-looking one that did not
- config that fought back, and what settled it
- a default that is wrong for this project
- an error message and its actual cause

## What does not belong here

- narrative ("I started by reading the docs, then...")
- what you built — that is the diary
- design decisions — those go in `../docs/decisions-made-overnight.md`
- anything already stated in `../docs/BUILD-PLAN.md`

## Style

Terse. One fact per bullet. Prefer a command and its output over a sentence about a command.
If you learned nothing worth passing on, write one line saying so — an empty file is ambiguous,
a one-line file is not.
