import type { Template } from "../templates.js";

/**
 * The connected agent (Claude, Hermes, ...) is already a strong writer, so instead of calling a second
 * model this returns a tight brief: the transcript with timestamps, the template, YouTube's hard limits
 * and a checklist. The agent writes the metadata and checks it with preview_metadata.
 */
export function metadataBrief(input: {
  transcript: string;
  durationSeconds?: number;
  template?: Template;
  format: "video" | "short";
  language?: string;
  notes?: string;
}) {
  const long = (input.durationSeconds ?? 0) >= 300;
  return {
    instructions: [
      "Write YouTube metadata for this video from the transcript below, then call preview_metadata with it before uploading or updating.",
      "Give 3 title options and mark one as recommended. Under 70 characters each (hard limit 100). Lead with the concrete thing that happens; no clickbait, no ALL CAPS, no hashtags in titles.",
      "Description: first line under 100 characters that works as a search snippet; then 2 to 4 short paragraphs on what the viewer gets; then key links or calls to action if the template has them (the template footer is added automatically, do not repeat it).",
      long
        ? "Chapters: the video is 5+ minutes, so add a chapter list in the description. First chapter must be 0:00, at least 3 chapters, each at least 10 seconds long, timestamps taken from the transcript."
        : "Chapters: only if the video is 5+ minutes long. First chapter must be 0:00, at least 3 chapters, each at least 10 seconds.",
      "Tags: 8 to 15, broad to specific, total under 500 characters. Hashtags: 3 to 5 at most (the template may add some).",
      input.format === "short"
        ? 'This is a Short: keep the title punchy, description 1 to 3 lines, and use the "shorts" template or add #Shorts.'
        : "",
      'YouTube rejects "<" and ">" anywhere in titles and descriptions.',
      input.template?.guidance
        ? `Channel voice (from the "${input.template.name}" template): ${input.template.guidance}`
        : "",
      input.language
        ? `Write in language: ${input.language}.`
        : "Write in the language spoken in the video.",
      input.notes ? `Notes from the user: ${input.notes}` : "",
    ].filter(Boolean),
    output_shape: {
      titles: ["option 1", "option 2", "option 3"],
      recommended_title: "one of the options",
      description: "full description text, chapters included when relevant",
      tags: ["..."],
      hashtags: ["#..."],
      chapters: [{ time: "0:00", label: "..." }],
      pinned_comment: "optional: a first comment that invites replies",
      thumbnail_text: "optional: 2 to 5 words for the thumbnail, not repeating the title",
    },
    template: input.template
      ? {
          name: input.template.name,
          title_format: input.template.title_format,
          footer_added_automatically: Boolean(input.template.description_footer),
          tags_added_automatically: input.template.tags ?? [],
          hashtags_added_automatically: input.template.hashtags ?? [],
        }
      : undefined,
    duration_seconds: input.durationSeconds,
    transcript: input.transcript,
  };
}

/** Parse an ISO-8601 duration (PT1H2M3S) into seconds. */
export function isoDurationSeconds(d?: string | null): number | undefined {
  if (!d) return undefined;
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d);
  if (!m) return undefined;
  return (
    Number(m[1] ?? 0) * 86400 +
    Number(m[2] ?? 0) * 3600 +
    Number(m[3] ?? 0) * 60 +
    Number(m[4] ?? 0)
  );
}

/** Validate a chapter list embedded in a description against YouTube's rules. */
export function checkChapters(description: string): string[] {
  const times = [...description.matchAll(/^\s*\(?((?:\d+:)?\d{1,2}:\d{2})\)?\s+\S/gm)].map((m) => {
    const p = m[1].split(":").map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  });
  if (!times.length) return [];
  const issues: string[] = [];
  if (times[0] !== 0) issues.push("Chapters: the first timestamp must be 0:00.");
  if (times.length < 3) issues.push("Chapters: YouTube needs at least 3 timestamps.");
  for (let i = 1; i < times.length; i++) {
    if (times[i] <= times[i - 1]) issues.push("Chapters: timestamps must be in ascending order.");
    else if (times[i] - times[i - 1] < 10)
      issues.push("Chapters: each chapter must be at least 10 seconds long.");
  }
  return [...new Set(issues)];
}
