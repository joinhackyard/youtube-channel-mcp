import { z } from "zod";
import type { AiSettings } from "../config.js";
import { YtError } from "../errors.js";
import { applyTemplate, type Template } from "../templates.js";
import { checkChapters } from "./brief.js";
import { AI_NOT_CONFIGURED_HINT, generateJson, type ImageInput } from "./providers.js";
import { seoCheck } from "../growth.js";

/** Shared voice for everything the server writes. Specific and honest beats clickbait. */
const CRAFT = `You are an expert YouTube strategist and copywriter who has grown many channels.
Principles:
- Packaging (title + thumbnail) decides whether people click; the first 30 seconds decide whether they stay.
- Strong titles are specific, create a curiosity gap or a clear promise, front-load the most searchable words, and stay under 60 characters when possible (hard limit 100).
- Never promise what the video doesn't deliver. No fake urgency, no misleading claims, no ALL CAPS words except short acronyms, at most one emoji.
- The title and thumbnail text work as a pair: the thumbnail says what the title doesn't.
- Descriptions: first line hooks and carries the main keyword; then value; chapters for videos over 5 minutes (first at 0:00, at least 3, each at least 10 seconds).
- Write in the language of the video unless told otherwise.`;

function voice(template?: Template) {
  return template?.guidance ? `\nChannel voice (must follow): ${template.guidance}` : "";
}

async function run<T>(
  ai: AiSettings,
  task: "text" | "vision",
  system: string,
  prompt: string,
  schema: z.ZodType<T>,
  images?: ImageInput[],
) {
  const r = await generateJson(ai, task, { system, prompt, schema, images });
  if (!r)
    throw new YtError(
      "not_configured",
      `No AI ${task === "vision" ? "vision" : "writing"} model is configured.`,
      { hint: AI_NOT_CONFIGURED_HINT },
    );
  return r;
}

// ---- metadata -------------------------------------------------------------------------------------

const MetadataDraft = z.object({
  titles: z
    .array(
      z.object({
        title: z.string(),
        angle: z
          .string()
          .describe("Why it works: curiosity, outcome, number, contrarian, search..."),
      }),
    )
    .describe("3 to 5 distinct title options"),
  recommended_title: z.string(),
  description: z
    .string()
    .describe(
      "Full description without the template footer; chapters included when the video is 5+ minutes",
    ),
  tags: z.array(z.string()),
  hashtags: z.array(z.string()).describe("2 to 4, each starting with #"),
  pinned_comment: z.string().describe("A first comment from the channel that invites replies"),
  thumbnail_texts: z
    .array(z.string())
    .describe("3 options, 2 to 5 words each, complementing (not repeating) the title"),
  primary_keyword: z.string().describe("The main search phrase this video should rank for"),
});
export type MetadataDraft = z.infer<typeof MetadataDraft>;

export interface MetadataInput {
  transcript: string;
  durationSeconds?: number;
  template?: Template;
  format: "video" | "short";
  language?: string;
  notes?: string;
}

export async function draftMetadata(ai: AiSettings, input: MetadataInput) {
  const prompt = [
    `Write YouTube metadata for this ${input.format === "short" ? "Short" : "video"}.`,
    input.durationSeconds ? `Duration: ${input.durationSeconds} seconds.` : "",
    input.template?.title_format
      ? `The template formats titles as "${input.template.title_format}" automatically; write only the {title} part.`
      : "",
    input.template?.description_footer
      ? "The template appends a footer with links; don't repeat it."
      : "",
    input.language ? `Write in: ${input.language}.` : "",
    input.notes ? `Notes from the creator: ${input.notes}` : "",
    `\nTranscript (timestamps in [m:ss]):\n${input.transcript}`,
  ]
    .filter(Boolean)
    .join("\n");
  const { data, model } = await run(
    ai,
    "text",
    CRAFT + voice(input.template),
    prompt,
    MetadataDraft,
  );
  const ready = applyTemplate(
    {
      title: data.recommended_title,
      description: [data.description, data.hashtags.join(" ")].filter(Boolean).join("\n\n"),
      tags: data.tags,
    },
    input.template,
  );
  return {
    model,
    draft: data,
    ready_to_use: {
      title: ready.title,
      description: ready.description,
      tags: ready.tags,
      playlists: ready.playlists,
    },
    checks: {
      warnings: [...ready.warnings, ...checkChapters(ready.description)],
      seo: seoCheck({
        title: ready.title,
        description: ready.description,
        tags: ready.tags,
        keyword: data.primary_keyword,
        durationSeconds: input.durationSeconds,
      }),
    },
  };
}

// ---- optimisation & diagnosis ---------------------------------------------------------------------

const Diagnosis = z.object({
  verdict: z.enum([
    "breakout",
    "above_average",
    "average",
    "below_average",
    "underperforming",
    "too_early",
  ]),
  summary: z.string().describe("2 to 3 sentences, plain language"),
  strengths: z.array(z.string()),
  problems: z.array(
    z.object({
      area: z.enum(["packaging", "hook", "retention", "seo", "audience", "topic", "other"]),
      issue: z.string(),
      evidence: z.string(),
      fix: z.string(),
    }),
  ),
  title_variants: z
    .array(z.object({ title: z.string(), angle: z.string() }))
    .describe("3 to 5 alternatives to A/B test"),
  thumbnail_ideas: z
    .array(z.object({ concept: z.string(), text: z.string(), why: z.string() }))
    .describe("2 to 4"),
  description_first_line: z.string(),
  tags: z.array(z.string()),
  next_actions: z.array(z.string()).describe("Ordered, most impactful first"),
});

export async function diagnoseVideo(ai: AiSettings, facts: unknown, template?: Template) {
  return run(
    ai,
    "text",
    CRAFT + voice(template),
    `Diagnose this video's performance and say exactly what to change. Base every claim on the numbers below (compare with the channel baseline). Retention points are fractions of the video (0.1 = 10% in). If the video is under 3 days old, say it is too early to judge views but still review packaging and hook.\n\n${JSON.stringify(facts, null, 1)}`,
    Diagnosis,
  );
}

// ---- comments -------------------------------------------------------------------------------------

const CommentTriage = z.object({
  sentiment: z
    .object({ positive: z.number(), neutral: z.number(), negative: z.number() })
    .describe("Shares that add up to 1"),
  themes: z.array(
    z.object({ theme: z.string(), share: z.number(), example_comment_ids: z.array(z.string()) }),
  ),
  questions: z
    .array(z.object({ comment_id: z.string(), question: z.string(), suggested_reply: z.string() }))
    .describe("Unanswered questions worth a reply"),
  reply_worthy: z
    .array(z.object({ comment_id: z.string(), why: z.string(), suggested_reply: z.string() }))
    .describe("Praise, useful feedback, or conversation starters"),
  needs_moderation: z.array(
    z.object({ comment_id: z.string(), reason: z.enum(["spam", "scam", "abuse", "off_topic"]) }),
  ),
  content_ideas: z
    .array(z.object({ idea: z.string(), evidence: z.string() }))
    .describe("Videos the audience is asking for"),
});

export async function triageComments(
  ai: AiSettings,
  comments: { id: string; text: string; likes?: number; author?: string; video?: string }[],
  channelVoice?: string,
) {
  return run(
    ai,
    "text",
    `You manage community for a YouTube channel. Be warm, brief and specific in replies; never argue; never invent facts about the video.${channelVoice ? `\nChannel voice: ${channelVoice}` : ""}`,
    `Triage these comments. Use the given ids exactly.\n${JSON.stringify(comments)}`,
    CommentTriage,
  );
}

// ---- translations ---------------------------------------------------------------------------------

const Translations = z.object({
  translations: z.array(
    z.object({ language: z.string(), title: z.string(), description: z.string() }),
  ),
});

export async function translateMetadata(
  ai: AiSettings,
  title: string,
  description: string,
  languages: string[],
) {
  return run(
    ai,
    "text",
    "You localise YouTube titles and descriptions. Keep meaning, tone and search intent; adapt idioms; keep links, timestamps, @handles and #hashtags unchanged; titles at most 100 characters.",
    `Languages (BCP-47): ${languages.join(", ")}\n\nTitle: ${title}\n\nDescription:\n${description}`,
    Translations,
  );
}

// ---- Shorts ---------------------------------------------------------------------------------------

const ShortsPlan = z.object({
  clips: z.array(
    z.object({
      start: z.number().describe("seconds"),
      end: z.number().describe("seconds"),
      hook: z.string().describe("The first line viewers hear or read"),
      title: z.string(),
      why: z.string(),
      score: z.number().describe("1 to 10 viral potential"),
    }),
  ),
});

export async function suggestShorts(
  ai: AiSettings,
  transcript: string,
  count: number,
  maxSeconds: number,
) {
  return run(
    ai,
    "text",
    `${CRAFT}\nYou find the moments in long videos that work as standalone Shorts: a strong first line within 2 seconds, one clear idea, a payoff, no missing context.`,
    `Pick the ${count} best Short clips (each 15 to ${maxSeconds} seconds; start on a sentence boundary). Transcript with timestamps:\n${transcript}`,
    ShortsPlan,
  );
}

// ---- ideas ----------------------------------------------------------------------------------------

const Ideas = z.object({
  ideas: z.array(
    z.object({
      title: z.string(),
      format: z.enum(["long", "short", "series", "live"]),
      angle: z.string(),
      why_now: z.string().describe("Evidence from the data: outliers, comments, search terms"),
      thumbnail_concept: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
});

export async function contentIdeas(
  ai: AiSettings,
  facts: unknown,
  count: number,
  template?: Template,
) {
  return run(
    ai,
    "text",
    CRAFT + voice(template),
    `Suggest ${count} next videos for this channel, grounded in the data below. Prefer ideas that repeat what already outperformed, answer audience questions, or ride rising topics.\n\n${JSON.stringify(facts, null, 1)}`,
    Ideas,
  );
}

// ---- thumbnails -----------------------------------------------------------------------------------

const ThumbConcepts = z.object({
  concepts: z.array(
    z.object({
      text_on_image: z.string(),
      image_prompt: z.string().describe("Detailed prompt for an image model"),
      why: z.string(),
    }),
  ),
});

export async function thumbnailConcepts(
  ai: AiSettings,
  title: string,
  context: string,
  count: number,
  style?: string,
) {
  return run(
    ai,
    "text",
    `${CRAFT}\nThumbnail rules: readable at phone size (max 4 words of text, huge type), one focal subject, strong emotion or clear object, high contrast, uncluttered background, no small details, leave space for the timestamp in the bottom-right.`,
    `Design ${count} different YouTube thumbnail concepts for the title "${title}".${style ? ` Style: ${style}.` : ""}\nContext: ${context}\nEach image_prompt must describe a 16:9 image and include the exact overlay text in quotes if text should be rendered.`,
    ThumbConcepts,
  );
}

const ThumbCritique = z.object({
  ranking: z.array(
    z.object({
      index: z.number().describe("0-based position of the image as given"),
      score: z.number().describe("1 to 10"),
      readability_at_small_size: z.number(),
      emotional_pull: z.number(),
      clarity_of_subject: z.number(),
      title_fit: z.number(),
      strengths: z.array(z.string()),
      fixes: z.array(z.string()),
    }),
  ),
  best_index: z.number(),
  summary: z.string(),
});

export async function critiqueThumbnails(ai: AiSettings, images: ImageInput[], title: string) {
  return run(
    ai,
    "vision",
    `${CRAFT}\nJudge thumbnails as a viewer scrolling on a phone sees them (about 168x94 px). Scores 1 to 10.`,
    `Title: "${title}". Rate each of the ${images.length} thumbnails (in order, index from 0), then pick the best for click-through without misleading.`,
    ThumbCritique,
    images,
  );
}
