---
name: example-plugin
version: 1.2.0
---

# Example Plugin

A minimal plugin that shows what the marketplace README looks like.

## Commands

| Command | Description | Example |
| --- | --- | --- |
| `/hello` | Greets the user in the current locale | `/hello world` |
| `/sync` | Pulls the latest catalog snapshot | `/sync --force` |
| `/search` | Searches plugins by name or tag | `/search pinyin` |

## Notes

- Install with `npm i example-plugin`.
- Works offline after the first sync.

```ts
// code fences must survive untouched
export const greet = (name: string) => `Hello, ${name}!`;
```
