# Privacy

dispatch-board 0.1.0. It runs on your machine, inside Claude Code, and sends nothing anywhere.

## What it never does

- No network request. It does not call `$.http` or anything else that leaves the machine.
- No model call, and nothing added to the conversation. The `/dispatch-board` command answers with no text, so the model never reads the board.
- No write to any file. It calls `$.fs.read` and `$.fs.list`, never `$.fs.write`.
- No hook on a tool call, a prompt, a permission decision or the system prompt. It hooks three events: `session.start` (to register its command), its own `/dispatch-board` command, and the drawing of its own pane.

`docs/surface.txt` lists every event it hooks, every engine call it makes and every environment variable it reads, as `claude plugin validate` reports them. `scripts/surface.sh` fails when the code and that list differ, so a new call or read has to show up in a diff.

## What it reads

With the `command` option empty (the default), it reads an agent-dispatch home, which is `$AGENT_DISPATCH_HOME` or `~/.agent-dispatch`:

- the names in `orders/`;
- each order's `state.json`: `state`, `attempt`, `started_at`, `queued_at`, `finished_at`, `current_worker`, `slot_worker`, and from each entry of `attempts` the `worker`, `started_at` and `cost`;
- `meta.json` of orders that are still open: `project` (reduced to its last path segment at once), `worker`, and `title`;
- the modification times of an open order's log files, to tell a live run from a dead one. The logs themselves are not opened;
- `config.json`: `max_parallel` and each worker's `budget_usd_month`. The file is parsed in memory, those numbers are taken, and the rest is dropped. Nothing else from it is kept, stored or drawn.

It reads two environment variables, `AGENT_DISPATCH_HOME` and `HOME`, to find that folder. Their values are not drawn or stored.

With `command` set, it reads none of the above. It runs your command as an argument list (no shell, so nothing in it is expanded or interpreted), kills it after 5 seconds, and parses what it printed.

With `demo` on, it reads nothing at all.

## What reaches the screen

Order id, project directory name, lane name, state, round, and durations. Per lane: this month's spend and budget. With `showTitles` on, also each order's title, cut to 40 characters.

Not the work order's text, not reports, not notes, not full paths. Whatever a data source prints beyond the fields in the README's contract is dropped before anything is kept or drawn. A failure shows as one line: the reason's first line, cut to 60 characters, with any absolute path reduced to its last segment.

One thing to know: an order id is whatever your orchestrator makes it. agent-dispatch builds ids from a timestamp and a slug of the title, so a few title words are in the id whether or not `showTitles` is on.

## What it keeps

- In the session (`$.state`): the last snapshot, as drawn. Gone when the session ends.
- On disk (`$.store`, a JSON file under `~/.claude/plugins/store/`): the last snapshot and the time it was fetched, so that several open sessions share one fetch. It holds the same reduced fields that reach the screen, and titles only while `showTitles` is on. Claude Code removes the store after its own `cleanupPeriodDays`; uninstalling the plugin leaves nothing else behind.

## Version

This page describes 0.1.0. A release that reads, keeps or draws anything new changes this page and `docs/surface.txt` in the same commit.
