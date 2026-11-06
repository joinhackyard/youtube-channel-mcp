import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../app.js";
import { APP, VERSION } from "../config.js";
import { registerAccountTools } from "./tools/account.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerVideoTools } from "./tools/videos.js";

const INSTRUCTIONS = `YouTube publishing through the official YouTube Data API v3.

Start with auth_status. If no channel is connected, call connect_channel (it opens Google sign-in in the browser).

Publishing workflow:
1. generate_metadata (transcript, captions file, existing video, or transcribe a local file) → write title/description/chapters/tags → preview_metadata.
2. upload_video with file_path (a path on this computer) or url. It returns a job_id; follow it with get_upload_status. Uploads resume from the last byte after network drops or restarts.
3. Thumbnail, playlists and captions can go in the same upload_video call, or later via set_thumbnail, add_to_playlist, upload_captions.
4. Wait until get_upload_status says ready before telling the user the video is live.

Safety: anything public, unlisted, scheduled, or destructive needs the user's approval. If a tool returns CONFIRMATION REQUIRED, show the summary to the user and only call again with the confirmation_token after they say yes. Never invent approval.

Quota: one Google Cloud project has a daily budget (about 100 uploads and 10,000 API units). On quota errors, stop; jobs resume after the midnight Pacific reset.
Unaudited Google Cloud projects may have uploads forced to private; tools report it when it happens. Publish such videos in YouTube Studio.`;

export function buildServer(app: App): McpServer {
  const server = new McpServer(
    { name: APP, title: "YouTube Publisher", version: VERSION },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );
  registerAccountTools(server, app);
  registerUploadTools(server, app);
  registerVideoTools(server, app);
  registerLibraryTools(server, app);

  server.registerPrompt(
    "publish_video",
    {
      title: "Publish a video to YouTube",
      description:
        "Guided flow: transcript → metadata → upload → thumbnail/playlists → confirm visibility.",
      argsSchema: {
        file_path: z.string().describe("Path to the video on this computer"),
        template: z
          .string()
          .optional()
          .describe("Template name (see list_templates)"),
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
