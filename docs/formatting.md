# Formatting

`format` is `plain` by default: the text is sent exactly as given. With `"format": "markdown"` a small subset is rendered and the markers are removed:

| Write                  | You see                                  |
| ---------------------- | ---------------------------------------- |
| `` `ls -la` ``         | `ls -la` in monospace                    |
| ` ```diff ` fence      | a monospace block (language is optional) |
| `**bold**`, `*italic*` | bold, italic                             |
| `~~old~~`              | strikethrough                            |
| `## Heading`           | the heading text in bold                 |
| `> quote`              | a quote block                            |

An agent can send this:

````
Force-push `feature/login` to origin?

```diff
-  return token
+  return token.trim()
```
````

and the owner sees the branch name in monospace and the diff as a monospace block, with the backticks gone.

Anything that isn't in the table stays as typed: lists, tables, links, images, HTML and `_underscores`. A marker that doesn't pair up, or sits inside a word (`2*3*4`, `snake_case`, `src/**/*.ts`), stays literal too, so a malformed message still arrives. Put a `\` before a marker to show it as is. Text inside code is never changed. To show a block that itself contains a fence, open it with a longer one (four backticks around three). Line breaks are kept as written.

The text limit counts the text after the markup is removed, so the source may be longer. A message that renders to nothing but whitespace is a 400. Put commands in code: a glob like `ls *foo* bar` looks exactly like emphasis, and in markdown mode it would show as `ls foo bar` in italics.

On Telegram, if it refuses the formatting, the service sends the message again as plain text (the rendered text, without the markers) and logs one line, so the question still gets through.

`format` needs a service at least as new as this release; an older one shows the markdown as typed. Re-run `init` to upgrade.
