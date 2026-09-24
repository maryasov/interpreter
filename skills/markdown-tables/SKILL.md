---
name: markdown-tables
description: How to translate table cells without breaking GFM layout.
when: table, |
---

When translating table cells:

- Translate only the visible text of a cell. Never emit `|`, and never add or
  remove columns — the row must keep the same number of cells.
- Cells addressed as inline code (e.g. `` `/hello` ``) are protected; leave them
  byte-identical.
- Keep numbers, versions, flags (`--force`), and product names verbatim.
- Header cells and body cells are translated the same way; row/column position is
  given to you as context (`cell r<row>c<col>`) — use it only to keep terms
  consistent down a column.
