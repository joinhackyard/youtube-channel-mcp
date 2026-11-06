import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { YtError } from "./errors.js";

export const TemplateSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  extends: z.string().optional(),
  /** `{title}` is replaced with the agent's title, e.g. "{title} | My Show". */
  title_format: z.string().optional(),
  description_header: z.string().optional(),
  description_footer: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  category_id: z.string().optional(),
  default_language: z.string().optional(),
  default_audio_language: z.string().optional(),
  made_for_kids: z.boolean().optional(),
  license: z.enum(["youtube", "creativeCommon"]).optional(),
  embeddable: z.boolean().optional(),
  playlists: z.array(z.string()).optional(),
  guidance: z.string().optional(),
});
export type Template = z.infer<typeof TemplateSchema>;

/** Built in: only what is universal. Channel-specific templates live as JSON files in the templates folder. */
export const BUILTIN_TEMPLATES: Template[] = [
  {
    name: "shorts",
    description: "YouTube Shorts (vertical, up to 3 minutes): puts #Shorts in the description.",
    hashtags: ["#Shorts"],
  },
];

export interface MetadataInput {
  title: string;
  description?: string;
  tags?: string[];
  category_id?: string;
  default_language?: string;
  default_audio_language?: string;
  made_for_kids?: boolean;
  license?: "youtube" | "creativeCommon";
  embeddable?: boolean;
}

export interface ResolvedMetadata extends Required<
  Pick<MetadataInput, "title" | "description" | "tags">
> {
  category_id: string;
  default_language?: string;
  default_audio_language?: string;
  made_for_kids: boolean;
  license?: "youtube" | "creativeCommon";
  embeddable?: boolean;
  playlists: string[];
  template?: string;
  warnings: string[];
}

export class TemplateStore {
  private readonly map = new Map<string, Template>();

  constructor(private readonly dir: string) {
    this.reload();
  }

  reload() {
    this.map.clear();
    this.errors.length = 0;
    for (const t of BUILTIN_TEMPLATES) this.map.set(t.name, t);
    for (const dir of [this.dir]) {
      if (!dir || !existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
        try {
          const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
          for (const t of Array.isArray(raw) ? raw : [raw]) {
            const parsed = TemplateSchema.parse(t);
            this.map.set(parsed.name, parsed);
          }
        } catch (e) {
          this.errors.push(`${f}: ${(e as Error).message}`);
        }
      }
    }
  }

  /** Problems found while loading template files (shown by list_templates). */
  readonly errors: string[] = [];

  save(t: Template): string {
    const parsed = TemplateSchema.parse(t);
    if (!/^[\w-]{1,64}$/.test(parsed.name)) {
      throw new YtError(
        "invalid_request",
        "Template names may use letters, numbers, - and _ only.",
      );
    }
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${parsed.name}.json`);
    writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
    this.reload();
    return file;
  }

  remove(name: string): boolean {
    if (!/^[\w-]{1,64}$/.test(name)) return false;
    const file = join(this.dir, `${name}.json`);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    this.reload();
    return true;
  }

  list(): Template[] {
    return [...this.map.values()].map((t) => this.get(t.name));
  }

  /** Template with its `extends` chain merged (child wins; tags and hashtags are combined). */
  get(name: string, seen = new Set<string>()): Template {
    const t = this.map.get(name);
    if (!t)
      throw new YtError("not_found", `Unknown template "${name}".`, {
        hint: `Templates: ${[...this.map.keys()].join(", ")}`,
      });
    if (!t.extends || seen.has(name)) return t;
    seen.add(name);
    const base = this.get(t.extends, seen);
    const merged: Template = {
      ...base,
      ...Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined)),
    } as Template;
    merged.tags = dedupe([...(t.tags ?? []), ...(base.tags ?? [])]);
    merged.hashtags = dedupe([...(t.hashtags ?? []), ...(base.hashtags ?? [])]);
    merged.extends = undefined;
    return merged;
  }
}

const dedupe = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** YouTube counts each tag's length, plus 2 for quotes when it contains a space, plus commas. */
export function tagsLength(tags: string[]): number {
  return (
    tags.reduce((n, t) => n + t.length + (t.includes(" ") ? 2 : 0), 0) +
    Math.max(0, tags.length - 1)
  );
}

export function validateText(title: string, description: string) {
  const problems: string[] = [];
  if (!title.trim()) problems.push("Title is empty.");
  if (title.length > 100) problems.push(`Title is ${title.length} characters (YouTube max 100).`);
  if (/[<>]/.test(title) || /[<>]/.test(description))
    problems.push('YouTube rejects "<" and ">" in titles and descriptions.');
  if (Buffer.byteLength(description, "utf8") > 5000)
    problems.push(
      `Description is ${Buffer.byteLength(description, "utf8")} bytes (YouTube max 5000).`,
    );
  if (problems.length) throw new YtError("invalid_request", problems.join(" "));
}

/** Merge the agent's metadata with a template into exactly what will be sent to YouTube. */
export function applyTemplate(input: MetadataInput, template?: Template): ResolvedMetadata {
  const warnings: string[] = [];
  let title = input.title.trim();
  if (
    template?.title_format &&
    !title.includes(template.title_format.replace("{title}", "").trim())
  ) {
    const formatted = template.title_format.replace("{title}", title);
    if (formatted.length <= 100) title = formatted;
    else
      warnings.push(`Template title format skipped: "${formatted}" would exceed 100 characters.`);
  }
  if (title.length > 70)
    warnings.push(`Title is ${title.length} characters; mobile shows about 70.`);

  const body = (input.description ?? "").trim();
  const parts = [template?.description_header, body].filter((p): p is string => Boolean(p?.trim()));
  if (template?.description_footer && !body.includes(template.description_footer.split("\n")[0]))
    parts.push(template.description_footer);
  const hashtags = (template?.hashtags ?? []).filter(
    (h) => !body.toLowerCase().includes(h.toLowerCase()),
  );
  if (hashtags.length) parts.push(hashtags.join(" "));
  const description = parts.join("\n\n");

  let tags = dedupe([...(input.tags ?? []), ...(template?.tags ?? [])]);
  while (tags.length && tagsLength(tags) > 500) tags = tags.slice(0, -1);
  if (tags.length < dedupe([...(input.tags ?? []), ...(template?.tags ?? [])]).length)
    warnings.push("Some tags were dropped to stay under the 500-character tag limit.");

  validateText(title, description);
  return {
    title,
    description,
    tags,
    category_id: input.category_id ?? template?.category_id ?? "28",
    default_language: input.default_language ?? template?.default_language,
    default_audio_language: input.default_audio_language ?? template?.default_audio_language,
    made_for_kids: input.made_for_kids ?? template?.made_for_kids ?? false,
    license: input.license ?? template?.license,
    embeddable: input.embeddable ?? template?.embeddable,
    playlists: template?.playlists ?? [],
    template: template?.name,
    warnings,
  };
}
