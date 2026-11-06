# YouTube Channel MCP

Run your whole YouTube channel from Claude, Hermes, Cursor, Codex, Windsurf or any MCP client. Upload and schedule videos, write titles and chapters from the transcript, fix metadata across the back catalogue, answer and moderate comments, refresh the channel profile and banner, organise playlists and captions, and ask how the channel is doing.

> “Upload `~/Videos/ep12.mp4` with chapters from the transcript, add it to the Podcast playlist and schedule it for Friday 6 pm.”
> “Which videos brought in the most subscribers this month, and where did the views come from?”
> “Show me comments held for review and reply to the questions.”

It runs on your own computer, talks only to the **official YouTube Data API v3 and YouTube Analytics API**, and keeps your Google sign-in in your **OS keychain**. No browser automation, no cookies, no third-party server.

```bash
npx youtube-channel-mcp setup
```

Setup takes about five minutes: it walks you through creating your Google credentials, connects your channel, and adds itself to the AI apps it finds on your machine.

## What it covers

| Area | |
|---|---|
| **Publishing** | Upload local files or public URLs with resumable 16 MB chunks, checkpointed to disk: a dropped connection or closed app resumes from the last byte YouTube confirmed. Private, unlisted, public or scheduled (`publish_at`). Thumbnail, playlists and captions in the same call. |
| **Videos** | List everything on the channel (including private and scheduled), edit title, description, tags, category, languages, audience and AI-content disclosure, translate titles and descriptions, publish, unlist, schedule, delete. |
| **Metadata** | `generate_metadata` hands your AI the transcript with timestamps plus YouTube's rules; it writes the copy. `preview_metadata` checks limits and chapter rules before anything is sent. Templates add your standard footer, links, tags and naming. |
| **Channel** | Profile and stats, description, keywords, country, language, trailer for non-subscribers, translations, banner, video watermark. |
| **Comments** | Read comments per video or across the channel, including *held for review* and *likely spam*; reply as the channel; publish, hold or remove; ban authors; delete your own comments. |
| **Analytics** | Overview, daily trend, top videos, traffic sources, YouTube search terms, geography, devices, age and gender, audience retention for a video, subscribed vs not, or any custom metrics and dimensions. |
| **Playlists** | List, create, edit, delete, add, remove, reorder. Name a playlist and it is found (or created). |
| **Captions** | Upload `.srt` / `.vtt`, replace, download, delete; optional transcription of local videos with any OpenAI-compatible speech-to-text API (OpenAI, Azure OpenAI, Groq, local Whisper). |
| **Several channels** | Connect any number of channels, including brand accounts; pick a default or name one per call. |
| **Quota-aware** | Tracks the daily budget, stops on `quotaExceeded` instead of hammering the API, and resumes stopped uploads after the midnight Pacific reset. |

## Install

Requirements: **Node.js 22.13+**. Optional: **ffmpeg**, only for transcription.

```bash
npx youtube-channel-mcp setup
```

Setup does four things:

1. **Google credentials** (one time). YouTube only allows this through an OAuth client you own, so setup opens the right Google Cloud pages and you click through:
   1. [Create a project](https://console.cloud.google.com/projectcreate).
   2. Enable the [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) and the [YouTube Analytics API](https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com).
   3. [Configure the OAuth consent screen](https://console.cloud.google.com/auth/overview): *External*, then under *Audience* either add your Google account as a test user, or click **Publish app** so sign-ins don't expire every 7 days (Google shows an “unverified app” notice you can click through for your own app).
   4. [Create an OAuth client](https://console.cloud.google.com/auth/clients/create) of type **Desktop app** and download the JSON.

   Then drag that JSON file into the terminal. The client ID and secret go into your keychain.
2. **Connect a channel.** Your browser opens Google sign-in; choose the account and the channel.
3. **Transcription** (optional).
4. **Add to your AI apps.** It detects and configures **Claude Desktop, Claude Code, Cursor, Windsurf, Codex and Hermes Agent**. Your original config is kept as `*.before-youtube-channel-mcp.bak`, and an existing server named `youtube` is never touched. Restart the app afterwards.

Prefer a global install? `npm i -g youtube-channel-mcp && youtube-channel-mcp setup`.

### Manual configuration

`npx youtube-channel-mcp config` prints snippets for your machine. The general shape:

```json
{
  "mcpServers": {
    "youtube-channel": { "command": "npx", "args": ["-y", "youtube-channel-mcp@latest"] }
  }
}
```

Hermes Agent (`~/.hermes/config.yaml`), where tools appear as `mcp_youtube_channel_*`:

```yaml
mcp_servers:
  youtube-channel:
    command: "npx"
    args: ["-y", "youtube-channel-mcp@latest"]
    timeout: 180
```

Claude Code: `claude mcp add youtube-channel --scope user -- npx -y youtube-channel-mcp@latest`

## Try it

- “Check my YouTube connection.”
- “Upload ~/Videos/launch.mp4 as private with the title ‘We shipped v2’, then show me the upload status.”
- “Transcribe ~/Videos/episode-12.mp4, write three title options, a description with chapters and tags using my podcast template, and schedule it for Friday 18:00 IST with ~/Videos/ep12.jpg as the thumbnail.”
- “How did the channel do in the last 28 days compared with the month before? Which five videos drove it?”
- “What are people searching on YouTube to find us?”
- “List comments held for review, publish the genuine ones and remove the spam.”
- “Reply to the unanswered questions on my latest video.”
- “Rewrite the channel description and keywords around hackathons and founders.”
- “Add Hindi titles and descriptions to my five most viewed videos.”
- “Make every video in the ‘Drafts’ playlist unlisted.”

## Tools

| Tool | What it does |
|---|---|
| `auth_status` · `connect_channel` · `list_channels` · `set_default_channel` · `disconnect_channel` | Connection, sign-in health, quota, known limits |
| `upload_video` · `get_upload_status` · `list_uploads` · `cancel_upload` · `resume_upload` | Background uploads from a file or URL, with progress and resume |
| `list_my_videos` · `get_video` · `update_video` · `set_visibility` · `set_thumbnail` · `set_video_localizations` · `delete_video` · `list_categories` | Videos |
| `get_channel` · `update_channel` · `set_channel_banner` · `set_watermark` | Channel profile and branding |
| `list_comments` · `reply_to_comment` · `moderate_comments` · `delete_comment` | Comments and moderation |
| `get_analytics` | YouTube Analytics reports for the channel or a video |
| `list_playlists` · `create_playlist` · `update_playlist` · `delete_playlist` · `add_to_playlist` · `remove_from_playlist` · `move_in_playlist` · `list_playlist_items` | Playlists |
| `list_captions` · `upload_captions` · `download_captions` · `delete_captions` · `transcribe_video` | Captions and transcripts |
| `generate_metadata` · `preview_metadata` · `list_templates` · `save_template` · `delete_template` | Writing metadata and channel templates |
| `quota_status` | Today's quota estimate |

There is also a `publish_video` prompt for clients that support MCP prompts.

## Approvals

Reading is free. Private uploads and private edits go straight through. Anything other people will see or that cannot be undone needs your approval: public, unlisted or scheduled uploads and visibility changes, public replies and comments, channel profile and banner changes, removing comments or banning authors, and deleting videos, playlists, captions or channels.

- In clients that support MCP elicitation, you get a confirm dialog.
- Otherwise the tool returns `CONFIRMATION REQUIRED` with a summary and a single-use token tied to those exact arguments. The AI is instructed to show you the summary and call again with the token only after you agree; if the arguments change, the token is rejected. This fallback relies on the AI following instructions, so prefer clients with elicitation, or `YT_CONFIRM=always`, when the AI reads untrusted text such as comments.

Set `YT_CONFIRM=always` to confirm every write, or `never` for unattended pipelines.

## Templates

Templates are JSON files in `~/.youtube-channel-mcp/templates/` (or ask your AI to call `save_template`):

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
- **Not available through the API:** pinning comments, changing the channel name or handle, community posts, and Shorts-specific editing. Do those in YouTube Studio.
- **Phone verification.** Custom thumbnails and videos over 15 minutes need a [verified channel](https://www.youtube.com/verify).

## Configuration

Everything works without these. Environment variables override what setup stored.

| Variable                                        | Default                     |                                                                                                 |
| ----------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`     | from keychain               | Desktop-app OAuth client                                                                        |
| `YT_MCP_HOME`                                   | `~/.youtube-channel-mcp`  | Data folder (state database, templates, transcripts)                                            |
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
- Requested scopes: `youtube.upload`, `youtube`, `youtube.force-ssl` (comments, captions and deletes) and `yt-analytics.readonly` (reports). No monetary or revenue access.
- URL downloads refuse private and internal addresses.
- `disconnect_channel` revokes the token at Google.
- An audit log of uploads and changes is kept in the local database.

## CLI

```
youtube-channel-mcp setup              guided setup (safe to re-run)
youtube-channel-mcp connect            connect or reconnect a channel
youtube-channel-mcp status             channels, quota, recent uploads
youtube-channel-mcp doctor             check everything, explain fixes
youtube-channel-mcp install [ids|all]  claude-desktop, claude-code, cursor, windsurf, codex, hermes
youtube-channel-mcp uninstall [ids]
youtube-channel-mcp config             print config snippets
```

## Develop

```bash
git clone https://github.com/shyamolkonwar/youtube-channel-mcp && cd youtube-channel-mcp
npm install && npm test
node dist/src/cli.js setup     # or: node dist/src/cli.js install --node
```

Issues and pull requests are welcome.

## License

MIT. Built by [Hackyard](https://hackyard.org). Not affiliated with YouTube or Google.
