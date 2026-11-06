# YouTube Publisher MCP

Publish to YouTube from Claude, Hermes, Cursor, Codex, Windsurf or any MCP client: “upload `~/Videos/recap.mp4`, write the title and chapters from the transcript, add it to the Podcast playlist and schedule it for Friday 6 pm.”

It runs on your own computer, talks to the **official YouTube Data API v3**, and keeps your Google sign-in in your **OS keychain**. No browser automation, no cookies, no third-party server.

```bash
npx youtube-publisher-mcp setup
```

The setup takes about five minutes: it walks you through creating your Google credentials, connects your channel, and adds itself to the AI apps it finds on your machine.

## What it can do

|                        |                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Upload**             | Local files or public URLs. Resumable uploads in 16 MB chunks, checkpointed to disk: a dropped connection or a closed app resumes from the last byte YouTube confirmed instead of starting over. Several GB is fine.                 |
| **Schedule & publish** | Private, unlisted, public, or `publish_at` scheduling. Anything other people can see needs your approval first.                                                                                                                      |
| **Thumbnails**         | JPG/PNG up to 2 MB, set during upload or later.                                                                                                                                                                                      |
| **Playlists**          | List, create, add, remove, reorder by position. Playlists can be named; missing ones are created.                                                                                                                                    |
| **Captions**           | Upload `.srt` / `.vtt`, replace tracks, download your captions.                                                                                                                                                                      |
| **Metadata**           | Edit title, description, tags, category, languages, made-for-kids and AI-content disclosure. Templates add your standard footer, links, tags and naming. `preview_metadata` checks limits and chapter rules before anything is sent. |
| **Transcripts**        | Optional: transcribe a local video with any OpenAI-compatible speech-to-text API (OpenAI, Azure OpenAI, Groq, a local Whisper server) to write metadata, chapters and captions.                                                      |
| **Channel overview**   | List videos (including private and scheduled), details, processing status, statistics, categories.                                                                                                                                   |
| **Quota-aware**        | Tracks the daily budget, stops on `quotaExceeded` instead of hammering the API, and resumes stopped uploads automatically after the midnight Pacific reset.                                                                          |
| **Several channels**   | Connect any number of channels, including brand accounts; pick a default or name one per call.                                                                                                                                       |

## Install

Requirements: **Node.js 22.13+**. Optional: **ffmpeg**, only for transcription.

```bash
npx youtube-publisher-mcp setup
```

Setup does four things:

1. **Google credentials** (one time). YouTube only allows uploads through an OAuth client you own, so setup opens the right Google Cloud pages and you click through:
   1. [Create a project](https://console.cloud.google.com/projectcreate).
   2. [Enable the YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
   3. [Configure the OAuth consent screen](https://console.cloud.google.com/auth/overview): _External_, then under _Audience_ either add your Google account as a test user, or click **Publish app** so sign-ins don't expire every 7 days (Google will show an “unverified app” notice that you can click through for your own app).
   4. [Create an OAuth client](https://console.cloud.google.com/auth/clients/create) of type **Desktop app** and download the JSON.

   Then drag that JSON file into the terminal. The client ID and secret go into your keychain.

2. **Connect a channel.** Your browser opens Google sign-in; choose the account and the channel.
3. **Transcription** (optional).
4. **Add to your AI apps.** It detects and configures **Claude Desktop, Claude Code, Cursor, Windsurf, Codex and Hermes Agent** (your original config is kept as `*.before-youtube-publisher-mcp.bak`; an existing server named `youtube` is never touched). Restart the app afterwards.

Prefer a global install? `npm i -g youtube-publisher-mcp && youtube-publisher-mcp setup`.

### Manual configuration

`npx youtube-publisher-mcp config` prints snippets for your machine. The general shape:

```json
{
  "mcpServers": {
    "youtube-publisher": {
      "command": "npx",
      "args": ["-y", "youtube-publisher-mcp@latest"]
    }
  }
}
```

Hermes Agent (`~/.hermes/config.yaml`):

```yaml
mcp_servers:
  youtube-publisher:
    command: "npx"
    args: ["-y", "youtube-publisher-mcp@latest"]
    timeout: 180
```

Claude Code: `claude mcp add youtube-publisher --scope user -- npx -y youtube-publisher-mcp@latest`

## Try it

- “Check my YouTube connection.”
- “Upload ~/Videos/launch.mp4 as private with the title ‘We shipped v2’, then show me the upload status.”
- “Transcribe ~/Videos/episode-12.mp4, write three title options, a description with chapters and tags using my podcast template, and upload it scheduled for Friday 18:00 IST with ~/Videos/ep12.jpg as the thumbnail.”
- “List my private videos from this month and make the one about pricing unlisted.”
- “Add my last three uploads to the ‘Build Logs’ playlist.”

## Tools

| Tool                                                                                                      | What it does                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_status`                                                                                             | Configuration, connected channels and sign-in health, quota, known limits                                                                |
| `connect_channel` · `list_channels` · `set_default_channel` · `disconnect_channel`                        | Manage channels (Google sign-in in your browser)                                                                                         |
| `upload_video`                                                                                            | File or URL + metadata, privacy or `publish_at`, thumbnail, playlists, captions, template. Runs in the background and returns a `job_id` |
| `get_upload_status` · `list_uploads` · `cancel_upload` · `resume_upload`                                  | Follow uploads and YouTube processing; resume after quota resets or reconnecting                                                         |
| `get_video` · `list_my_videos` · `update_video` · `set_visibility` · `delete_video`                       | Inspect and change videos                                                                                                                |
| `set_thumbnail`                                                                                           | Custom thumbnail from a local JPG/PNG                                                                                                    |
| `list_playlists` · `create_playlist` · `add_to_playlist` · `remove_from_playlist` · `list_playlist_items` | Playlists                                                                                                                                |
| `list_captions` · `upload_captions` · `download_captions` · `transcribe_video`                            | Captions and transcripts                                                                                                                 |
| `generate_metadata` · `preview_metadata`                                                                  | Brief from a transcript (your AI writes the copy), then a dry run of exactly what will be sent                                           |
| `list_templates` · `save_template` · `delete_template`                                                    | Channel templates                                                                                                                        |
| `list_categories` · `quota_status`                                                                        | Reference data and quota                                                                                                                 |

There is also a `publish_video` prompt for clients that support MCP prompts.

## Approvals

Uploads that stay **private** go straight through. **Public, unlisted or scheduled** uploads, visibility changes, deletions and disconnects need your approval:

- In clients that support MCP elicitation, you get a confirm dialog.
- Otherwise the tool returns `CONFIRMATION REQUIRED` with a summary and a single-use token tied to those exact arguments. The AI is instructed to show you the summary and call again with the token only after you agree; if the arguments change, the token is rejected. This fallback relies on the AI following instructions, so prefer clients with elicitation, or `YT_CONFIRM=always`, when the AI reads untrusted text.

Set `YT_CONFIRM=always` to confirm every upload, or `never` for unattended pipelines.

## Templates

Templates are JSON files in `~/.youtube-publisher-mcp/templates/` (or ask your AI to call `save_template`):

```json
{
  "name": "podcast",
  "description": "Weekly episode",
  "title_format": "{title} | My Podcast",
  "description_footer": "Listen everywhere: https://example.com/podcast",
  "hashtags": ["#Podcast"],
  "tags": ["podcast", "interview"],
  "category_id": "22",
  "playlists": ["Podcast episodes"],
  "guidance": "Lead with the guest's name and the one idea listeners take away."
}
```

`extends` inherits another template. Tags and hashtags are combined, the footer is appended, and `guidance` is passed to your AI when it writes metadata. A built-in `shorts` template adds `#Shorts`. See [`examples/templates`](examples/templates).

## Things YouTube decides (worth knowing)

- **Unaudited projects upload as private.** Google Cloud projects created after July 2020 that haven't passed the [YouTube API compliance audit](https://support.google.com/youtube/contact/yt_api_form) can have every API upload locked to private. The server detects this and tells you; publish those videos in YouTube Studio, or apply for the audit.
- **Testing-mode sign-ins last 7 days.** If your consent screen is in _Testing_, Google expires the sign-in weekly. Reconnect (`connect_channel`), or publish the consent screen. Stopped uploads resume on their own after you reconnect.
- **Quota.** Each Google Cloud project has a daily budget shared by every channel connected through it (by default about 10,000 API units; uploads have their own allowance). `quota_status` shows this server's estimate; the Cloud Console has the exact numbers.
- **Phone verification.** Custom thumbnails and videos over 15 minutes need a [verified channel](https://www.youtube.com/verify).

## Configuration

Everything works without these. Environment variables override what setup stored.

| Variable                                        | Default                     |                                                                                                 |
| ----------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`     | from keychain               | Desktop-app OAuth client                                                                        |
| `YT_MCP_HOME`                                   | `~/.youtube-publisher-mcp`  | Data folder (state database, templates, transcripts)                                            |
| `YT_CONFIRM`                                    | `public`                    | `public`, `always` or `never`                                                                   |
| `YT_CHUNK_MB`                                   | `16`                        | Upload chunk size (rounded to 256 KB)                                                           |
| `YT_DAILY_UNIT_LIMIT` / `YT_DAILY_UPLOAD_LIMIT` | `10000` / `100`             | Budgets used for the local estimate                                                             |
| `YT_MCP_VAULT`                                  | auto                        | Set to `file` to use the encrypted file instead of the OS keychain                              |
| `TRANSCRIBE_API_KEY` (or `OPENAI_API_KEY`)      |                             | Speech-to-text key                                                                              |
| `TRANSCRIBE_BASE_URL` (or `OPENAI_BASE_URL`)    | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint, e.g. `https://<resource>.cognitiveservices.azure.com/openai/v1` |
| `TRANSCRIBE_MODEL`                              | `whisper-1`                 | Model or deployment name                                                                        |

## Security

- Google refresh tokens and client secrets are stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). On machines without one, they go into an AES-256-GCM encrypted file with a separate `0600` key file.
- Sign-in uses a one-shot `127.0.0.1` loopback server with PKCE and a random state, as Google recommends for desktop apps.
- Requested scopes: `youtube.upload`, `youtube` and `youtube.force-ssl` (captions and deletes need the last one).
- URL downloads refuse private and internal addresses.
- `disconnect_channel` revokes the token at Google.
- An audit log of uploads and changes is kept in the local database.

## CLI

```
youtube-publisher-mcp setup              guided setup (safe to re-run)
youtube-publisher-mcp connect            connect or reconnect a channel
youtube-publisher-mcp status             channels, quota, recent uploads
youtube-publisher-mcp doctor             check everything, explain fixes
youtube-publisher-mcp install [ids|all]  claude-desktop, claude-code, cursor, windsurf, codex, hermes
youtube-publisher-mcp uninstall [ids]
youtube-publisher-mcp config             print config snippets
```

## Develop

```bash
git clone https://github.com/shyamolkonwar/youtube-publisher-mcp && cd youtube-publisher-mcp
npm install && npm test
node dist/src/cli.js setup     # or: node dist/src/cli.js install --node
```

Issues and pull requests are welcome.

## License

MIT. Built by [Hackyard](https://hackyard.org). Not affiliated with YouTube or Google.
