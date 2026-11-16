# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/dingyifeng123456-spec/makefun-markdown-render-speed-02-v3/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/dingyifeng123456-spec/makefun-markdown-render-speed-02-v3/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer whose output is byte-identical
to **marked 18.1.3** (default options: GFM on, breaks off, pedantic off),
and faster than marked.

Entry point is `main.ts` (Node 22). It exports a single `parse` function
and also works as a driver: it reads a list of Markdown inputs and writes
the rendered HTML for each.

## Usage

```js
import { parse } from './main.ts';

const html = parse('# Hello\n\nSome *emphasised* text.\n');
```

`parse` takes one Markdown string and returns its HTML string. Each call
is independent: no state is shared between calls, no caching across cases.

## Design

The whole renderer lives in one file, `main.ts`, with no dependencies:

- **Block parser** — a CommonMark-style open-block stack. Containers
  (blockquotes, list items) are matched per line; lazy continuation keeps
  paragraph text verbatim where the spec requires it. Link reference
  definitions are stripped at paragraph finalisation, so forward
  references work. Tables are detected at paragraph finalisation.
- **Inline parser** — a single scan producing tokens (text, code, links,
  images, HTML, breaks, delimiters), then delimiter resolution following
  the CommonMark emphasis algorithm (including the rule of three), then
  rendering. Autolinks (angle-bracket and extended), email links, and
  `mailto:`/`xmpp:` scheme links are recognised.
- **Compatibility details** — byte-identical output was verified against
  marked on the 720-case practice set (652 CommonMark, 28 GFM, 40
  generated documents), including: entity handling, code-span escaping,
  fenced-code indent stripping, HTML-block types and their trailing
  newlines, table cell counts and `\|` handling, lazy setext lines in
  blockquotes, and list looseness.

## Performance

The parser is a single pass with no backtracking over the input. Inline
scanning avoids regular expressions on the hot path where possible, and
delimiter resolution works on a compact token array. The practice set
(about 2.9 MB of Markdown) renders in roughly 2 seconds end to end
including Node startup; in-process it is faster than marked on the same
inputs (see the benchmark in the validation notes).

## Compatibility notes

A few behaviours that are easy to get wrong, and how this renderer
handles them:

- A fenced code block drops exactly one trailing blank content line.
- An HTML block takes a trailing newline only when the next line is not
  truly empty (a whitespace-only line does not suppress it).
- A lazy continuation line inside a list item loses four columns of
  indent when its indent is four or more; a smaller indent is kept
  verbatim.
- A link label may contain an image or a code span, but a shortcut or
  full reference label may not contain an unescaped `[` (other than as
  part of an image). An empty label is not a valid reference.
- After a hard break, the next line's leading whitespace is stripped.

## Files

- `main.ts` — the renderer (single file, no dependencies).
- `README.md` — this file.
- `LICENSE` — MIT.
- `.gitignore` — ignores local build artefacts.
- `.makefun/owner.json` — the owner's wallet for this bounty.
