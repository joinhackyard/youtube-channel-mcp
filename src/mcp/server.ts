import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../app.js";
import { APP, VERSION } from "../config.js";
import { registerAccountTools } from "./tools/account.js";
import { registerAiTools } from "./tools/ai.js";
import { registerChannelTools } from "./tools/channel.js";
import { registerGrowthTools } from "./tools/growth.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerVideoTools } from "./tools/videos.js";

const INSTRUCTIONS = `Manage a YouTube channel through the official YouTube Data and Analytics APIs.

Start with auth_status. If no channel is connected, call connect_channel (it opens Google sign-in in the browser).

What you can do:
- Publish: generate_metadata → write title/description/chapters/tags → preview_metadata → upload_video (file_path on this computer, or url) → follow get_upload_status until ready. Thumbnail, playlists and captions can go in the same call. Uploads resume from the last byte after drops or restarts.
- Videos: list_my_videos, get_video, update_video, set_visibility (publish/unlist/schedule), set_thumbnail, set_video_localizations, delete_video.
- Channel: get_channel, update_channel (description, keywords, trailer, translations), set_channel_banner, set_watermark.
- Community: list_comments (per video or channel-wide, including held-for-review and likely spam), reply_to_comment, moderate_comments, delete_comment.
- Analytics: get_analytics (overview, daily, top_videos, traffic_sources, search_terms, geography, devices, demographics, retention, custom).
- Grow: analyze_video (outlier score, hook retention, traffic, search terms, SEO, AI diagnosis), find_outliers, research_topic (breakout videos on a topic), best_publish_time, seo_check, content_ideas.
- A/B test: create_ab_test rotates title/thumbnail/description variants daily and picks a winner with a significance test (also from upload_video via ab_test); get_ab_test, list_ab_tests, stop_ab_test.
- Create: generate_metadata, suggest_shorts + create_short (vertical cut), extract_frames, generate_thumbnails, critique_thumbnails, triage_comments, translate_video_metadata.
- AI providers (Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq, Ollama): see ai_status. Without one, these tools return the data and a brief so you write the result yourself. They never publish; show drafts to the user.
- Organise: playlists (list/create/update/delete/add/remove/reorder), captions (list/upload/download/delete, transcribe_video), templates.

Safety: anything public (publishing, scheduling, public replies, channel profile and banner changes) or destructive needs the user's approval. If a tool returns CONFIRMATION REQUIRED, show the summary to the user and only call again with the confirmation_token after they say yes. Never invent approval.

Quota: one Google Cloud project has a daily budget (about 100 uploads and 10,000 API units). On quota errors, stop; uploads resume after the midnight Pacific reset.
Unaudited Google Cloud projects may have uploads forced to private; tools report it when it happens.`;

export function buildServer(app: App): McpServer {
  const server = new McpServer(
    { name: APP, title: "YouTube Channel Manager", version: VERSION },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );
  registerAccountTools(server, app);
  registerUploadTools(server, app);
  registerVideoTools(server, app);
  registerLibraryTools(server, app);
  registerChannelTools(server, app);
  registerAiTools(server, app);
  registerGrowthTools(server, app);

  server.registerPrompt(
    "publish_video",
    {
      title: "Publish a video to YouTube",
      description:
        "Guided flow: transcript → metadata → upload → thumbnail/playlists → confirm visibility.",
      argsSchema: {
        file_path: z.string().describe("Path to the video on this computer"),
        template: z.string().optional().describe("Template name (see list_templates)"),
        visibility: z
          .string()
          .optional()
          .describe("private, unlisted, public, or a date-time to schedule"),
      },
    },
    ({ file_path, template, visibility }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Publish ${file_path} to my YouTube channel.`,
              template
                ? `Use the "${template}" template.`
                : "Check list_templates and use one if it fits.",
              `Target visibility: ${visibility ?? "private (I will decide later)"}.`,
              "Steps: auth_status; generate_metadata (transcribe the file if no transcript is available, otherwise ask me for one); write 3 title options, a description with chapters if long, and tags; preview_metadata; show me the plan; then upload_video and follow it with get_upload_status until processing finishes. Ask before anything goes public.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
  return server;
}
