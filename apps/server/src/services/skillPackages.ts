import { createHash } from "node:crypto";
import yaml from "js-yaml";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export class SkillPackageError extends Error {
  readonly status = 400;
  readonly details = undefined;
}

export type SkillPackageData = {
  name: string;
  description: string;
  skillMd: string;
  references: Record<string, string>;
  compatibility: string | null;
  unsupportedFiles: string[];
  digest: string;
};

const MAX_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_ENTRIES = 64;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const parseSkillMd = (skillMd: string, references: Record<string, string>, unsupportedFiles: string[]): SkillPackageData => {
  const normalized = skillMd.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (Buffer.byteLength(normalized, "utf8") > MAX_FILE_BYTES) throw new Error("SKILL.md exceeds the size limit");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error("SKILL.md needs YAML frontmatter and instructions");
  const metadata = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid Skill metadata");
  const fields = metadata as Record<string, unknown>;
  if (typeof fields.name !== "string" || fields.name.length > 64 || !NAME_PATTERN.test(fields.name)) throw new Error("Invalid Skill name");
  if (typeof fields.description !== "string" || !fields.description.trim() || fields.description.length > 1024) throw new Error("Invalid Skill description");
  if (fields.compatibility !== undefined && (typeof fields.compatibility !== "string" || fields.compatibility.length > 500)) throw new Error("Invalid Skill compatibility");
  if (fields["allowed-tools"] !== undefined && typeof fields["allowed-tools"] !== "string") throw new Error("Invalid Skill allowed-tools field");
  if (Buffer.byteLength(match[2], "utf8") > MAX_FILE_BYTES) throw new Error("Skill instructions exceed the size limit");
  const sortedReferences = Object.fromEntries(Object.entries(references).sort(([a], [b]) => a.localeCompare(b)));
  const digest = createHash("sha256").update(JSON.stringify({ skillMd: normalized, references: sortedReferences })).digest("hex");
  return {
    name: fields.name,
    description: fields.description.trim(),
    skillMd: normalized,
    references: sortedReferences,
    compatibility: typeof fields.compatibility === "string" ? fields.compatibility : null,
    unsupportedFiles: [...unsupportedFiles].sort(),
    digest
  };
};

export const parseSkillMarkdown = (skillMd: string): SkillPackageData => parseSkillMd(skillMd, {}, []);

const readZipEntry = (zip: ZipFile, entry: Entry): Promise<Buffer> => new Promise((resolve, reject) => {
  zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) { reject(error ?? new Error("Unable to read ZIP entry")); return; }
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_FILE_BYTES) { stream.destroy(new Error("Skill file exceeds the size limit")); return; }
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
});

export const parseSkillZip = async (buffer: Buffer): Promise<SkillPackageData> => {
  if (!buffer.length || buffer.length > MAX_ZIP_BYTES) throw new Error("Skill ZIP exceeds the size limit");
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, file) => {
      if (error || !file) reject(error ?? new Error("Invalid Skill ZIP")); else resolve(file);
    });
  });
  try {
    const files = new Map<string, string>();
    const unsupportedFiles: string[] = [];
    const seen = new Set<string>();
    let entries = 0;
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          entries += 1;
          if (entries > MAX_ENTRIES) throw new Error("Skill ZIP contains too many entries");
          const rawPath = entry.fileName;
          if (!rawPath || rawPath.includes("\\") || rawPath.includes("\0") || rawPath.startsWith("/") || /^[a-zA-Z]:/.test(rawPath)) throw new Error("Invalid Skill ZIP path");
          const segments = rawPath.split("/").filter((segment) => segment.length > 0);
          if (segments.some((segment) => segment === "." || segment === "..") || !segments.length) throw new Error("Skill ZIP path escapes its package");
          const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (fileType === 0o120000) throw new Error("Skill ZIP cannot contain symbolic links");
          if (rawPath.endsWith("/")) { zip.readEntry(); return; }
          const path = segments.join("/");
          const folded = path.toLowerCase();
          if (seen.has(folded)) throw new Error("Skill ZIP contains duplicate paths");
          seen.add(folded);
          if (entry.uncompressedSize > MAX_FILE_BYTES) throw new Error("Skill file exceeds the size limit");
          total += entry.uncompressedSize;
          if (total > MAX_TOTAL_TEXT_BYTES) throw new Error("Skill ZIP exceeds the extracted size limit");
          if (/(^|\/)scripts\//i.test(path) || /\.(?:sh|ps1|py|js|mjs|cjs|exe|bat|cmd)$/i.test(path)) {
            unsupportedFiles.push(path);
            zip.readEntry();
            return;
          }
          if (path !== "SKILL.md" && !path.endsWith("/SKILL.md") && !/\.(?:md|txt|json|ya?ml)$/i.test(path)) {
            unsupportedFiles.push(path);
            zip.readEntry();
            return;
          }
          const contents = await readZipEntry(zip, entry);
          files.set(path, textDecoder.decode(contents));
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    const skillPaths = [...files.keys()].filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"));
    if (skillPaths.length !== 1) throw new Error("Skill ZIP must contain exactly one SKILL.md");
    const skillPath = skillPaths[0];
    const root = skillPath.slice(0, -"SKILL.md".length);
    if (root && root.slice(0, -1).includes("/")) throw new Error("Skill ZIP package must be at its root");
    for (const path of [...files.keys(), ...unsupportedFiles]) if (!path.startsWith(root)) throw new Error("Skill ZIP contains files outside the package");
    const references = Object.fromEntries([...files.entries()]
      .filter(([path]) => path !== skillPath)
      .map(([path, content]) => [path.slice(root.length), content]));
    const skill = parseSkillMd(files.get(skillPath)!, references, unsupportedFiles.map((path) => path.slice(root.length)));
    if (root && root.slice(0, -1) !== skill.name) throw new Error("Skill folder must match its name");
    return skill;
  } finally {
    zip.close();
  }
};

export const parseSkillImport = async (input: { format: "markdown" | "zip"; markdown?: string; dataBase64?: string }) => {
  try {
    if (input.format === "markdown") return parseSkillMarkdown(input.markdown ?? "");
    const encoded = input.dataBase64 ?? "";
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 2_800_000) throw new Error("Invalid Skill ZIP encoding");
    return await parseSkillZip(Buffer.from(encoded, "base64"));
  } catch (error) {
    throw new SkillPackageError(error instanceof Error ? error.message : "Invalid Skill package");
  }
};

export const BUILTIN_SKILLS = [
  parseSkillMarkdown("---\nname: story-continuity\ndescription: Check long roleplay timelines for contradictions, unresolved events, and missing evidence.\n---\nSearch the current chat for earlier agreements. Separate confirmed facts from possible conflicts. Cite actual message or memory IDs; state when the evidence is missing."),
  parseSkillMarkdown("---\nname: memory-organization\ndescription: Find duplicate or stale long-term memories in the current chat and propose reviewable changes.\n---\nSearch enabled memories in this chat. Compare their claims and sources. Suggest create, update, merge, or disable candidates. Keep the first merge target as the retained memory. Never claim a change was saved before the user confirms it."),
  parseSkillMarkdown("---\nname: character-consistency\ndescription: Compare a character's recent replies with its accessible card and embedded Lore.\n---\nRead the current character only. Check recent replies against the accessible character card and enabled embedded Lore. Respect private locked fields and distinguish actual contradictions from uncertain interpretation."),
  parseSkillMarkdown("---\nname: reply-writing\ndescription: Draft distinct user replies that fit the current single-character scene.\n---\nUse the current chat scene and cited context to prepare several concise user reply options with different tones. Return drafts as candidates for the user to insert; do not send a message automatically.")
] as const;
