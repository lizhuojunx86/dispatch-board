# AGENTS.md

dispatch-board is a Claude Code mod: a read-only side pane for delegated work orders. Read README.md for what it does and PRIVACY.md for what it may touch.

## Before every commit

```sh
claude plugin validate . --strict   # also type-checks hooks, adapters and tests
claude plugin test .
scripts/surface.sh                  # engine calls and env reads still match docs/surface.txt
```

If `scripts/surface.sh` fails because the mod now calls or reads something new, that is a privacy change: update PRIVACY.md, run `scripts/surface.sh --write`, and commit both together.

## Rules that are not style

- It watches and changes nothing. No hook on tool calls, prompts, permissions or the system prompt; nothing appended to the conversation; no model call; no network; no `$.fs.write`.
- A label holds an id, a directory name, a lane, a state or a number. Titles only behind `showTitles`, cut to 40 characters. Everything a data source prints goes through `normalize()` before it is kept or drawn.
- A fault in the board never reaches the session: every hook hands its event on, and every function that takes `$` catches its own failures.
- The built-in adapter never runs `agent-dispatch status`. That command reconciles dead runners, which writes state files and signals processes.
- Nothing real goes into this repository: no real order ids, project names, titles or spend. Fixtures are synthetic, and screenshots use `demo: true`.

## Things that cost time once

- `claude plugin validate` reads a `$.state` reference only from the file that uses it. `hooks/register.tsx` and `hooks/poller.ts` each declare the same atom on purpose.
- Matchers in `on(...)` must be string literals, or validate reports `command=?` and lists the hook as a gate.
- In tests, plugin options go in `test(name, { options: {...} }, body)`.
- `claude --plugin-dir .` asks the workspace trust question in an untrusted folder. Start it from a trusted directory with an absolute path if you only want to look.

## Layout

`hooks/register.tsx` the three hooks · `hooks/poller.ts` when to fetch, sharing between sessions · `hooks/model.ts` normalization and the view model, pure · `hooks/view.tsx` drawing · `hooks/demo.ts` sample data · `adapters/agent-dispatch.ts` the file reader · `types/index.d.ts` the snapshot contract and the state key · `tests/` behaviour, named by what it guarantees.
