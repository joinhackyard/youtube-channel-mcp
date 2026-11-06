# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-11-06

### Added
- **A/B testing** of titles, thumbnails and descriptions (`create_ab_test`, `get_ab_test`, `list_ab_tests`, `stop_ab_test`, or `ab_test` on `upload_video`):
  - One version is live per Pacific day, in balanced random order.
  - Results use trend-adjusted Welch t-tests on views, watch time, average view percentage, average view duration, subscribers or engagement.
  - A significant winner is applied automatically.
- **AI providers:** Anthropic Claude (official SDK, structured output, server-side refusal fallback), OpenAI, Azure OpenAI / AI Foundry, Google Gemini, OpenRouter, Groq, Ollama and any OpenAI-compatible API.
  - You choose a model for each job: writing, vision, image generation, transcription.
  - Keys are kept in the OS keychain.
  - New `ai` command: interactive, or scriptable with `--key-stdin`.
- **Growth tools:**
  - `analyze_video`: outlier score, hook retention, retention curve, traffic, search terms, SEO score and an AI diagnosis.
  - `find_outliers`, `research_topic` (breakout videos on a topic), `best_publish_time`, `seo_check`, `content_ideas`.
- **Shorts and thumbnails:**
  - `suggest_shorts` and `create_short` (vertical 1080x1920 cuts with ffmpeg).
  - `extract_frames`, `generate_thumbnails` (OpenAI, Azure or Gemini image models) and `critique_thumbnails` (vision models).
- **Community and reach:** `triage_comments` (themes, questions with draft replies, moderation candidates, ideas) and `translate_video_metadata`.
- **AI writing:** `generate_metadata` now returns a finished, template-merged draft with an SEO score when a writing model is connected.
- **Metadata checks:** `preview_metadata` includes an SEO/packaging score.
- **Paid promotion:** `has_paid_product_placement` disclosure on `upload_video` and `update_video`.
- **Background service:** `daemon` plus `service install|uninstall|status` (launchd, systemd, Task Scheduler) keep uploads and A/B tests running without an AI app open.

### Changed
- The OAuth client saved by `setup` now takes priority over a generic `GOOGLE_CLIENT_ID` in the environment. `YT_MCP_GOOGLE_CLIENT_ID` and `YT_MCP_GOOGLE_CLIENT_SECRET` override both.
- Each channel remembers which OAuth client connected it. Switching clients asks you to reconnect instead of failing with `invalid_grant`.
- The 1.0 transcription settings (`TRANSCRIBE_*`) move to the new provider settings automatically.

## [1.0.1] - 2026-11-06

### Changed
- The "OS keychain unavailable" notice is now a debug message. Headless machines quietly use the encrypted-file vault, and `status` and `doctor` still show which storage is in use.

### Added
- Contributing guide, code of conduct, security policy, support guide, issue and PR templates.
- Dependabot, CodeQL and OpenSSF Scorecard workflows.
- Prettier formatting check in CI.
- GitHub Releases are created from this changelog.

## [1.0.0] - 2026-11-06

First release.

### Added
- **Publishing:**
  - Resumable, checkpointed uploads from local files or URLs that survive drops and restarts.
  - Scheduling, thumbnails, playlists and captions in one call.
  - Approval gate for anything public.
- **Videos:** list, get, update, set visibility, translations, delete, categories.
- **Channel:** profile and stats, description, keywords, trailer, translations, banner, watermark.
- **Comments:** list per video or channel-wide, including held-for-review and likely spam; reply; moderate; ban; delete.
- **Analytics:** overview, daily, top videos, traffic sources, search terms, geography, devices, demographics, retention, custom reports.
- **Playlists:** list, create, update, delete, add, remove, reorder.
- **Captions:** upload, download, delete, and transcription through any OpenAI-compatible speech-to-text API.
- **Metadata:** briefs and previews, plus file-based templates.
- **Quota:** tracking, with automatic resume after the midnight Pacific reset.
- **Setup:** `setup` wizard and auto-install for Claude Desktop, Claude Code, Cursor, Windsurf, Codex and Hermes Agent.
- **Token storage:** OS keychain, with an encrypted-file fallback.

[Unreleased]: https://github.com/joinhackyard/youtube-channel-mcp/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/joinhackyard/youtube-channel-mcp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/joinhackyard/youtube-channel-mcp/compare/2bfe11b...v1.0.1
[1.0.0]: https://github.com/joinhackyard/youtube-channel-mcp/tree/2bfe11b
