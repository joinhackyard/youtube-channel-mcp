# Getting help

1. Run `npx @joinhackyard/youtube-channel-mcp doctor`. It checks Node, credentials, channel sign-in and ffmpeg, and tells you what to fix.
2. Read the README sections [Install](README.md#install) and [Things YouTube decides](README.md#things-youtube-decides-worth-knowing). Most problems are Google Cloud setup, Testing-mode sign-ins expiring after 7 days, or uploads locked to private on unaudited projects.
3. Ask in [Discussions](https://github.com/joinhackyard/youtube-channel-mcp/discussions).
4. Found a bug? [Open an issue](https://github.com/joinhackyard/youtube-channel-mcp/issues/new/choose) and include the `doctor` output.

## `SyntaxError: Unexpected end of input` in a cached dependency

If the stack points into `~/.npm/_npx/.../node_modules/@google/genai/dist/node/index.mjs`, the cached SDK file may be incomplete. Retry with a fresh temporary npm cache:

```sh
npm exec --yes --cache "$(mktemp -d)" --package=@joinhackyard/youtube-channel-mcp@latest -- youtube-channel-mcp connect
```

This leaves your saved channel connections and settings intact. If the error persists with a fresh cache, include the full stack trace in a bug report.
