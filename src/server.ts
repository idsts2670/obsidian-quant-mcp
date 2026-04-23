import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import matter from "gray-matter";

let vaultPath = process.env.OBSIDIAN_VAULT_PATH || "";
let vaultRealPath = "";

export function setVaultPath(p: string) {
  vaultPath = p;
}

async function resolveVaultPath(relativePath: string): Promise<string> {
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new McpError(ErrorCode.InvalidParams, "Path traversal not allowed");
  }
  const resolved = path.join(vaultPath, normalized);

  // Resolve symlinks to prevent escaping the vault via symlink indirection.
  // For new files (ENOENT), check the parent directory instead.
  try {
    const real = await fs.realpath(resolved);
    if (!real.startsWith(vaultRealPath + path.sep) && real !== vaultRealPath) {
      throw new McpError(ErrorCode.InvalidParams, "Path traversal not allowed");
    }
  } catch (e: any) {
    if (e instanceof McpError) throw e;
    if (e?.code === "ENOENT") {
      try {
        const parentReal = await fs.realpath(path.dirname(resolved));
        if (!parentReal.startsWith(vaultRealPath + path.sep) && parentReal !== vaultRealPath) {
          throw new McpError(ErrorCode.InvalidParams, "Path traversal not allowed");
        }
      } catch (e2: any) {
        if (e2 instanceof McpError) throw e2;
        // Parent doesn't exist yet either — let downstream handle
      }
    }
    // Other OS errors fall through; file operations will produce their own errors
  }

  return resolved;
}

function ensureMd(filePath: string): string {
  return filePath.endsWith(".md") ? filePath : filePath + ".md";
}

function requireString(args: Record<string, unknown> | undefined, key: string): string {
  const val = args?.[key];
  if (typeof val !== "string") {
    throw new McpError(ErrorCode.InvalidParams, `Missing or invalid parameter: ${key}`);
  }
  return val;
}

const MAX_SEARCH_RESULTS = 500;

// Recursively collect .md files, skipping hidden dirs and node_modules.
// Symlinks to .md files outside the vault are excluded.
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(full)));
    } else if (entry.name.endsWith(".md")) {
      if (entry.isSymbolicLink()) {
        try {
          const real = await fs.realpath(full);
          if (real.startsWith(vaultRealPath + path.sep)) files.push(full);
        } catch { /* skip unresolvable symlinks */ }
      } else {
        files.push(full);
      }
    }
  }
  return files;
}

// Extract first H1 heading or fall back to filename
function extractTitle(content: string, basename: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : basename;
}

// Return ~150 chars of surrounding text for a matched string
function extractContext(raw: string, matchStr: string): string {
  const idx = raw.indexOf(matchStr);
  if (idx === -1) return "";
  const start = Math.max(0, idx - 75);
  const end = Math.min(raw.length, idx + matchStr.length + 75);
  return raw.slice(start, end).replace(/\n/g, " ").trim();
}

function defaultDailyContent(dateStr: string): string {
  return `# ${dateStr}\n\n## Journal\n\n\n## Tasks\n\n`;
}

function applyTemplate(template: string, date: Date, dateStr: string): string {
  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return template
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{time\}\}/g, timeStr)
    .replace(/\{\{title\}\}/g, dateStr);
}

export async function startServer() {
  if (!vaultPath) {
    console.error("Error: vault path required. Use --vault-path or OBSIDIAN_VAULT_PATH.");
    process.exit(1);
  }

  try {
    const stat = await fs.stat(vaultPath);
    if (!stat.isDirectory()) {
      console.error(`Error: vault path is not a directory: ${vaultPath}`);
      process.exit(1);
    }
    vaultRealPath = await fs.realpath(vaultPath);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      console.error(`Error: vault path does not exist: ${vaultPath}`);
    } else {
      console.error(`Error: cannot access vault path: ${vaultPath}`, e);
    }
    process.exit(1);
  }

  const server = new Server(
    { name: "obsidian-quant-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "read_note",
        description: "Read a note from the vault. Returns content with parsed frontmatter.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from vault root (e.g. '_memory/memory.md')" },
          },
          required: ["path"],
        },
      },
      {
        name: "write_note",
        description: "Create or overwrite a note in the vault.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from vault root" },
            content: { type: "string", description: "Full note content (may include YAML frontmatter)" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "append_note",
        description: "Append content to an existing note, preserving its frontmatter.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from vault root" },
            content: { type: "string", description: "Markdown content to append" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "search_notes",
        description: "Full-text keyword search across all notes in the vault.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search term (case-insensitive)" },
          },
          required: ["query"],
        },
      },
      {
        name: "list_notes",
        description: "List markdown notes in the vault or a specific subdirectory.",
        inputSchema: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Optional subdirectory path relative to vault root" },
          },
        },
      },
      {
        name: "delete_note",
        description: "Delete a note from the vault.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path from vault root" },
          },
          required: ["path"],
        },
      },
      {
        name: "get_backlinks",
        description:
          "Find all notes that link to a given note via [[WikiLinks]] or standard markdown links. " +
          "Returns source path, note title, and a ≤150-char context snippet per backlink.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path of the target note, e.g. '_memory/decisions.md'",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "create_daily_note",
        description:
          "Create an Obsidian-style daily note at 'Daily Notes/YYYY-MM-DD.md'. " +
          "If it already exists, returns it without modification. " +
          "Supports optional template with {{date}}, {{time}}, {{title}} tokens.",
        inputSchema: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "ISO 8601 date string e.g. '2026-04-22'. Defaults to today.",
            },
            template: {
              type: "string",
              description: "Vault-relative path to a template note, e.g. 'templates/Daily.md'",
            },
            additionalContent: {
              type: "string",
              description: "Optional markdown content appended after template/default body.",
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // ── read_note ────────────────────────────────────────────────────────
        case "read_note": {
          const notePath = ensureMd(await resolveVaultPath(requireString(args, "path")));
          const raw = await fs.readFile(notePath, "utf-8");
          const { data: frontmatter, content } = matter(raw);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                path: args?.path,
                frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : null,
                content,
              }, null, 2),
            }],
          };
        }

        // ── write_note ───────────────────────────────────────────────────────
        case "write_note": {
          const notePath = ensureMd(await resolveVaultPath(requireString(args, "path")));
          await fs.mkdir(path.dirname(notePath), { recursive: true });
          await fs.writeFile(notePath, requireString(args, "content"), "utf-8");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, path: args?.path }) }] };
        }

        // ── append_note ──────────────────────────────────────────────────────
        case "append_note": {
          const notePath = ensureMd(await resolveVaultPath(requireString(args, "path")));
          let existing: string;
          try {
            existing = await fs.readFile(notePath, "utf-8");
          } catch (e: any) {
            if (e?.code === "ENOENT") {
              throw new McpError(ErrorCode.InvalidParams, `Note not found: ${args?.path}`);
            }
            throw e;
          }
          const { data: frontmatter, content } = matter(existing);
          const updated = matter.stringify(content + "\n" + requireString(args, "content"), frontmatter);
          await fs.writeFile(notePath, updated, "utf-8");
          return { content: [{ type: "text", text: JSON.stringify({ success: true, path: args?.path }) }] };
        }

        // ── search_notes ─────────────────────────────────────────────────────
        case "search_notes": {
          const query = requireString(args, "query").toLowerCase();
          const results: Array<{ path: string; line: number; snippet: string }> = [];
          const allFiles = await collectMarkdownFiles(vaultPath);
          outer: for (const file of allFiles) {
            const raw = await fs.readFile(file, "utf-8");
            const relPath = path.relative(vaultPath, file);
            const lines = raw.split("\n");
            for (let idx = 0; idx < lines.length; idx++) {
              if (results.length >= MAX_SEARCH_RESULTS) break outer;
              if (lines[idx].toLowerCase().includes(query)) {
                results.push({ path: relPath, line: idx + 1, snippet: lines[idx].trim().slice(0, 200) });
              }
            }
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                query,
                results,
                count: results.length,
                truncated: results.length >= MAX_SEARCH_RESULTS,
              }, null, 2),
            }],
          };
        }

        // ── list_notes ───────────────────────────────────────────────────────
        case "list_notes": {
          const base = args?.directory
            ? await resolveVaultPath(args.directory as string)
            : vaultPath;
          const notes: Array<{ path: string; name: string; isDirectory: boolean }> = [];
          const entries = await fs.readdir(base, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const rel = path.relative(vaultPath, path.join(base, entry.name));
            if (entry.isDirectory() || entry.name.endsWith(".md")) {
              notes.push({ path: rel, name: entry.name, isDirectory: entry.isDirectory() });
            }
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ notes, count: notes.length }, null, 2),
            }],
          };
        }

        // ── delete_note ──────────────────────────────────────────────────────
        case "delete_note": {
          const notePath = ensureMd(await resolveVaultPath(requireString(args, "path")));
          await fs.unlink(notePath);
          return { content: [{ type: "text", text: JSON.stringify({ success: true, path: args?.path }) }] };
        }

        // ── get_backlinks ────────────────────────────────────────────────────
        case "get_backlinks": {
          const targetRelPath = requireString(args, "path");
          const targetAbs = ensureMd(await resolveVaultPath(targetRelPath));
          const targetBasename = path.basename(targetAbs, ".md").toLowerCase();
          const targetRelNorm = path.relative(vaultPath, targetAbs);

          const allFiles = await collectMarkdownFiles(vaultPath);
          const backlinks: Array<{ fromPath: string; fromTitle: string; context: string }> = [];

          // [[WikiLink]] — captures target before any | alias or # heading
          const wikiRe = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
          // [text](path) — captures href before any # fragment or ? query
          const mdRe = /\[([^\]]*)\]\(([^)#?]+)(?:[#?][^\)]*)?\)/g;

          await Promise.all(allFiles.map(async (file) => {
            if (path.resolve(file) === path.resolve(targetAbs)) return;

            const raw = await fs.readFile(file, "utf-8");
            const fromPath = path.relative(vaultPath, file);
            const fromTitle = extractTitle(raw, path.basename(file, ".md"));

            for (const m of raw.matchAll(new RegExp(wikiRe.source, "g"))) {
              if (m[1].trim().toLowerCase() === targetBasename) {
                backlinks.push({ fromPath, fromTitle, context: extractContext(raw, m[0]) });
                return;
              }
            }

            for (const m of raw.matchAll(new RegExp(mdRe.source, "g"))) {
              const resolved = path.resolve(path.dirname(file), m[2]);
              const resolvedRel = path.relative(vaultPath, resolved);
              if (
                resolvedRel === targetRelNorm ||
                resolvedRel === targetRelNorm.replace(/\.md$/, "")
              ) {
                backlinks.push({ fromPath, fromTitle, context: extractContext(raw, m[0]) });
                return;
              }
            }
          }));

          return {
            content: [{
              type: "text",
              text: JSON.stringify({ path: targetRelPath, backlinks, count: backlinks.length }, null, 2),
            }],
          };
        }

        // ── create_daily_note ────────────────────────────────────────────────
        case "create_daily_note": {
          const date = args?.date ? new Date(args.date as string) : new Date();
          if (isNaN(date.getTime())) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid date: "${args?.date}"`);
          }

          const dateStr = date.toISOString().slice(0, 10);
          const notePath = path.join(vaultPath, "Daily Notes", `${dateStr}.md`);

          if (existsSync(notePath)) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ path: `Daily Notes/${dateStr}.md`, alreadyExisted: true }),
              }],
            };
          }

          await fs.mkdir(path.dirname(notePath), { recursive: true });

          let content: string;
          if (args?.template) {
            const templatePath = ensureMd(await resolveVaultPath(args.template as string));
            const templateRaw = await fs.readFile(templatePath, "utf-8");
            content = applyTemplate(templateRaw, date, dateStr);
          } else {
            content = defaultDailyContent(dateStr);
          }

          if (args?.additionalContent) {
            content = content.trimEnd() + "\n\n" + (args.additionalContent as string);
          }

          await fs.writeFile(notePath, content, "utf-8");
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ path: `Daily Notes/${dateStr}.md`, alreadyExisted: false }),
            }],
          };
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      throw new McpError(
        ErrorCode.InternalError,
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("obsidian-quant-mcp running on stdio");
}
