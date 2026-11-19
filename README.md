# dispatch-board

A side pane for Claude Code that shows where your delegated work orders stand and what each lane has spent this month.

I plan in Claude Code and hand the implementation to other models through a dispatcher. An order runs anywhere from 2 minutes to 2.5 hours, and I used to find out one had been waiting for my review by remembering to ask. Now it sits beside the chat:

```text
In flight 2/4 · queued 1 · needs you 3 · updated 12:01:22
Needs you (3)
20260107-101833-fix-i… · billing-ui · gpt-mini · check_failed · r2 · 41m
20260107-091204-add… · atlas-api · gpt-large · needs_review · r1 · 2h14m
20260106-221540-migrat… · docs-site · local-qwen · timeout · r1 · 13h00m
In flight (3)
20260107-112250-table-pa… · billing-ui · gpt-mini · reviewing · r2 · 27m
20260107-113902-split-auth… · atlas-api · gpt-large · running · r1 · 12m
20260107-114417-changelog-l… · docs-site · local-qwen · queued · r1 · 4m
Lane budget, this month
gpt-large · $72.60 / $70.00 · 103%
gpt-mini · $12.90 / $15.00 · 86%
claude-review · $6.10 / $30.00 · 20%
local-qwen · $0.42 / no cap
Finished in the last 24h: 7
```

That is the built-in demo data (`demo: true`), as the pane draws it 72 columns wide. A lane at 80% of its budget turns yellow, at 100% red. A running order with no sign of life for 20 minutes is marked `idle`.

It is read-only. Version 0.1 has no accept, redo or submit buttons: you still do those in your dispatcher.

## Install

At the prompt of a terminal session:

```
/plugin install dispatch-board --marketplace lizhuojunx86/dispatch-board
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install dispatch-board --marketplace lizhuojunx86/dispatch-board
```

Then type `/dispatch-board` to open the pane. Nothing is read until you do, and closing the pane stops the polling.

Built and tested on Claude Code 2.1.325 on macOS, in a terminal; I have also looked at it in the VS Code extension. Mods as a feature need 2.1.287 or later (2.1.299 in the VS Code extension); I have not tried this one on anything older than 2.1.325. The tree it draws passes the test kit's checks for the desktop app and mobile, but I have not looked at it on those two yet.

A mod is code that runs with your permissions, so read [PRIVACY.md](PRIVACY.md) and `docs/surface.txt` before you install this one. An install from this repository takes whatever `main` holds when you install or update. If you would rather pin it, clone the repository, check out a commit you have read, and add the clone instead: `claude plugin marketplace add ./dispatch-board`.

## Options

Set them on the install screen, or later with `/config`.

| Option | Default | Meaning |
| --- | --- | --- |
| `command` | empty | A command that prints a board snapshot as JSON (the contract is below). Run without a shell, killed after 5 seconds. Empty reads agent-dispatch's state files directly |
| `intervalSeconds` | `10` | Seconds between polls while work is in flight. With nothing in flight the board polls once a minute |
| `showTitles` | `false` | Show each order's title, cut to 40 characters. Off by default because a title is the only free text the board can draw |
| `maxRows` | `6` | The most rows each section draws. The rest become one `+N more` line |
| `demo` | `false` | Draw the sample data above and read nothing. For screenshots |
| `language` | `en` | `en` or `zh`, for the pane's labels |

## The snapshot contract

Every data source is reduced to this shape, and the pane draws nothing else:

```json
{
  "orders": [
    {
      "id": "20260107-113902-split-auth-middleware",
      "project": "atlas-api",
      "lane": "gpt-large",
      "state": "running",
      "round": 1,
      "startedAt": "2026-01-07T11:39:02Z",
      "updatedAt": "2026-01-07T11:50:41Z",
      "title": "Split the auth middleware"
    }
  ],
  "lanes": [{ "name": "gpt-large", "costMonth": 72.6, "budgetMonth": 70 }],
  "capacity": { "running": 2, "max": 4 }
}
```

- `orders` is required. `lanes` and `capacity` may be left out, and their sections are then not drawn.
- `id` and `state` are required per order. An order without them is skipped.
- `project` may be a path. Only its last segment is kept.
- `lane` is whatever you route work by: a model, a worker, a queue.
- `round` is the attempt number, from 1.
- `startedAt` and `updatedAt` are ISO 8601 strings or epoch milliseconds. A string with no zone is read as UTC. `startedAt` is when the current attempt started (or when the order was queued); `updatedAt` is the last sign of life while it runs, and the finish time afterwards.
- `title` is dropped unless `showTitles` is on.
- `budgetMonth: 0` means the lane has no cap.
- A finished order needs `updatedAt` to be counted in "Finished in the last 24h". Without it the board cannot tell today's from last year's and leaves it out.
- Any other field is dropped. Strings are cut (id 64, project 40, lane 24, state 24, title 40 characters).

The state decides the section:

| Section | States |
| --- | --- |
| In flight | `queued`, `running`, `reviewing` |
| Needs you | `needs_review`, `check_failed`, `timeout`, `conflict`, `worker_failed`, `no_changes`, `budget_exceeded`, `runner_error` |
| Finished (a count, last 24h only) | `accepted`, `rejected`, `cancelled`, `done` |

A state name the board does not know lands under "Needs you", so nothing is hidden by a typo. If your orchestrator's names differ, add `"bucket": "active"`, `"attention"` or `"done"` to the order and keep your own state name as the label.

Print as much history as you like. The snapshot keeps at most 200 open orders and the finished ones from the last 24 hours, and the pane draws finished orders as one number. How much the pane draws depends on `maxRows` alone: at the default it never holds more than 46 elements, whether your dispatcher has 5 finished orders or 1,000.

## Feeding it from another orchestrator

Write a command that prints the JSON above and set the `command` option to it, for example `python3 ~/bin/my-board.py`.

The command line is split on spaces (quotes group, `~/` is expanded) and run directly, with no shell: pipes, `$(…)` and `;` are plain arguments. Exit 0 and print one JSON document. Anything else shows in the pane as one line, such as `data is 20s old: my-board.py exited 3: …`, with the last good data still up.

Two things matter more than the format:

1. **The command must be read-only.** It runs every 10 seconds while work is in flight. I checked mine before pointing the board at it, and it was not: `agent-dispatch status --json` reconciles dead runners on every call, which rewrites state files and can signal process groups. That is why the built-in adapter reads the state files instead.
2. **Keep it under 5 seconds**, or it is killed and the pane says so.

If you would rather read files than run a process, `adapters/agent-dispatch.ts` is a worked example of about 300 lines: list a directory, read the JSON of orders that are still open, remember the finished ones, and tolerate a file that is missing or half-written.

## What polling costs

Measured on my machine, against 299 real orders (289 finished, 10 open):

- The first poll of a session reads every order once: 37 ms.
- Each later poll lists one directory and reads only the open orders: 1 to 4 ms.
- Drawing the pane takes 2 to 7 ms, and it is only redrawn when what it shows has changed. Durations are shown to the minute for that reason.
- No process is started in the default mode.

If you keep several sessions open, they share one snapshot through the plugin's store. A session that finds a snapshot younger than half the poll interval uses it and fetches nothing, so four open panes cost about the same as one. At the default interval a change reaches the session that fetches within 10 seconds and the ones that read its snapshot within 15.

## Development

```
claude plugin validate . --strict   # manifest, hooks module, types
claude plugin test .                # 32 tests, a couple of seconds
scripts/surface.sh                  # the engine calls still match docs/surface.txt
claude --plugin-dir .               # try it for one session
```

One test holds the file adapter against the dispatcher itself. `tests/fixtures/conformance.generated.ts` is a synthetic home plus what `agent-dispatch board --json` printed for it, and the test fails if the adapter would draw anything else from the same files. After a change to agent-dispatch, capture again with `python3 scripts/conformance.py /path/to/agent-dispatch` and run the tests. The first capture caught one difference: a queued order's `updatedAt`.

The tests state behaviour in their names. The ones I would not ship without: a failing, slow or half-printing command leaves the session's own events untouched; nothing but ids, directory names, lanes, states and numbers reaches a label; a poll that changes nothing redraws nothing; a thousand finished orders draw as many elements as five.

## Credit

The idea of a pane that only watches, and the habit of keeping the mod's surface in a checked-in file, come from [lot-map](https://github.com/alexeyw/lot-map) by alexeyw. lot-map draws what the session itself is doing and, on principle, reads no file and starts no process. dispatch-board is for the part that leaves the session, which is exactly what those principles keep off lot-map's map.

## License

MIT. See [LICENSE](LICENSE).
