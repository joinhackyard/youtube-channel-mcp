# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/joinhackyard/youtube-channel-mcp/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/joinhackyard/youtube-channel-mcp/compare/2bfe11b...v1.0.1
[1.0.0]: https://github.com/joinhackyard/youtube-channel-mcp/tree/2bfe11b
