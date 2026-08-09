# OMP next-prompt extension

A native [Oh My Pi](https://omp.sh) extension that predicts the next instruction a user is likely to enter after a completed agent response.

The extension waits for a terminal `agent_end`, skips automatic continuations and queued follow-ups, asks a configurable low-cost model for one short suggestion, and renders it below the editor.

```text
↳ next: run the focused tests  (Alt+/ to accept)
```

- **Alt+/** inserts the suggestion into the editor without submitting it.
- Focus, mouse, modifier, and navigation input leaves the suggestion visible.
- Typing or pasting dismisses the suggestion and aborts any in-flight request.
- Deleting the prompt back to empty re-shows the cached suggestion after two seconds without another model request.
- Suggestions are disabled in headless sessions and while OMP will continue automatically.

## Install

Clone the repository into OMP's user extension directory:

```bash
git clone --branch main https://github.com/CrazyCoder/omp-next-prompt-extension \
  ~/.omp/agent/extensions/next-prompt
```

OMP discovers the directory's `index.ts` automatically. Restart existing sessions after installation or updates.

To track the latest `main` revision:

```bash
git -C ~/.omp/agent/extensions/next-prompt pull --ff-only origin main
```

## Usage

Suggestions start enabled and use OMP's `@smol` model by default.

```text
/suggestions on
/suggestions off
/suggestions status
/suggestions model
/suggestions model slow
/suggestions model current
/suggestions model anthropic/claude-sonnet-4-6
/suggestions model reset
```

`/suggestions status` includes the last outcome, such as a shown suggestion, an intentional skip, unusable model output, timeout, or failure.

The model can also be selected at startup:

```bash
omp --suggestions-model @slow
```

Or through the `OMP_SUGGESTIONS_MODEL` environment variable. Precedence is CLI flag, environment variable, then `@smol`.

Each eligible completed response, including the first user exchange, adds one model request. Output is filtered to one useful 2–12 word instruction and capped at 100 characters.

## Develop

Requires [Bun](https://bun.sh):

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run verify:package
```

## License

MIT
