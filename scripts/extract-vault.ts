/**
 * Vault Extraction Script
 *
 * Reads the Elegant Automata Obsidian vault and generates structured data
 * for the Astro landing page at build time.
 *
 * Outputs:
 *   src/data/projects.json     — project tracker data
 *   src/data/canon.json        — full vault file tree with metadata
 *   src/data/daily.json        — snapshot for today (for diff history)
 *
 * Usage: npx tsx scripts/extract-vault.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Configuration ──────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VAULT_ROOT =
  process.env.EA_VAULT_ROOT ||
  path.join(
    process.env.HOME!,
    'workspace/ElegantAutomata/obsidian-vault'
  );

const OUTPUT_DIR = path.resolve(__dirname, '..', 'src', 'data');
const DAILY_DIR = path.resolve(OUTPUT_DIR, 'daily');

// Status emoji → machine-readable status
const STATUS_MAP: Record<string, string> = {
  '\u{1F7E2}': 'initiated',
  '\u{1F7E1}': 'planned',
  '\u{1F7E0}': 'active',
  '\u{1F534}': 'blocked',
  '\u2705': 'complete',
  '\u2B1C': 'pending',
};

// ── Deploy Gate configuration (Selective Pushes) ───────────────
const DEPLOY_GATE = {
  // Only compile files from these top-level sections
  allowedSections: [
    '00_META',
    '01_DSP_&_Audio_Physics',
    '02_Style_Extraction_&_Analysis',
    '03_Generative_Rhythm_&_Sequencing',
    '04_MUSIC_STUDIES',
    '05_Jazz_&_Fusion',
    '06_Guitar_Solos_&_Xenochrony'
  ],

  // Hard blacklist: skip files containing ANY of these tags
  blockedTags: [
    'private',
    'internal',
    'trade-secret',
    'draft',
    'personal-notes'
  ],

  // Set to true to require a specific whitelisted tag or 'public'
  requirePublicWhitelist: false,
  whitelistedTags: ['public', 'ea-research', 'music-theory', 'synthesis', 'production']
};

// ── Types ──────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  type: string;
  status: string;
  stack: string;
  link: string;
  detail?: ProjectDetail;
}

interface ProjectDetail {
  id: string;
  title: string;
  subtitle: string;
  description: string;
}

interface ExtractionResult {
  projects: Project[];
  extracted_at: string;
  vault_path: string;
}

interface CanonFile {
  path: string;           // relative to vault root
  title: string;          // extracted from first # heading
  subtitle?: string;      // extracted from ## or ###
  section: string;        // top-level directory (e.g. "01_DSP_&_Audio_Physics")
  size_bytes: number;
  modified: string;       // ISO date string
  word_count: number;
  excerpt: string;        // first 160 chars of body (after frontmatter/headers)
  tags: string[];         // any #hashtags found
  is_index: boolean;      // is this a _index.md or section landing?
}

interface CanonResult {
  files: CanonFile[];
  total_files: number;
  total_words: number;
  sections: string[];
  extracted_at: string;
  vault_path: string;
}

interface DailySnapshot {
  date: string;           // YYYY-MM-DD
  files: { path: string; title: string; size_bytes: number; modified: string }[];
  change_summary: string; // git log for today (if available)
}

// ── Helpers ────────────────────────────────────────────────────

function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\[\[(.*?)\]\]/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\|(.*?)$/g, '')
    .trim();
}

function parseStatus(cell: string): string {
  for (const [emoji, status] of Object.entries(STATUS_MAP)) {
    if (cell.includes(emoji)) return status;
  }
  return 'pending';
}

function parseProjectTable(lines: string[]): Project[] {
  const projects: Project[] = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('| ID | Project') && trimmed.includes('Status')) { inTable = true; continue; }
    if (inTable && /^\| :?-+/.test(trimmed)) continue;
    if (inTable && trimmed === '') break;
    if (!inTable || !trimmed.startsWith('| **')) continue;

    const cells = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 5) {
      projects.push({
        id: cleanMarkdown(cells[0]),
        name: cleanMarkdown(cells[1]),
        type: cleanMarkdown(cells[2]),
        status: parseStatus(cells[3]),
        stack: cleanMarkdown(cells[4]),
        link: cells.length >= 6 ? cleanMarkdown(cells[5]).replace(/^\[\[/, '').replace(/\]\]$/, '') : '',
      });
    }
  }
  return projects;
}

function parseProjectDetails(lines: string[]): ProjectDetail[] {
  const details: ProjectDetail[] = [];
  let current: Partial<ProjectDetail> | null = null;
  let collectingDescription = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^##\s+.+?\s+(EXP-\d+|DISC-\d+):\s+(.+)$/);

    if (headerMatch) {
      if (current && current.id) details.push(current as ProjectDetail);
      current = { id: headerMatch[1], title: headerMatch[2].trim(), subtitle: '', description: '' };
      if (lines[i + 1]?.startsWith('###')) {
        current.subtitle = lines[i + 1].replace(/^###\s*/, '').replace(/\*/g, '').trim();
        i++;
      }
      collectingDescription = false;
      continue;
    }

    if (current && !collectingDescription && line.trim().startsWith('*(')) { collectingDescription = true; continue; }

    if (current && collectingDescription && !current.description) {
      if (!line.trim() || line.startsWith('#') || line.startsWith('|') ||
          line.startsWith('```') || line.startsWith('>') || line.startsWith('-') || line.startsWith('![')) continue;
      const cleaned = line.replace(/\*\*/g, '').replace(/\[\[(.*?)\]\]/g, '$1').replace(/\[(.*?)\]\(.*?\)/g, '$1').trim();
      if (cleaned.length > 50) { current.description = cleaned; collectingDescription = false; }
    }
  }
  if (current && current.id) details.push(current as ProjectDetail);
  return details;
}

// ── Vault Canon Scanner ────────────────────────────────────────

/** Extract the title from a markdown file */
function extractTitle(lines: string[]): string {
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)/);
    if (match) return cleanMarkdown(match[1]);
  }
  return 'Untitled';
}

/** Extract subtitle from ## or ### */
function extractSubtitle(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = line.match(/^##\s+(.+)/) || line.match(/^###\s+(.+)/);
    if (match) {
      const title = match[1].replace(/^🚀\s*/, '').replace(/\*/g, '').trim();
      if (title.length > 5) return title;
    }
  }
  return undefined;
}

/** Extract frontmatter and inline hashtags based on Unified Tagging Strategy v1.0 */
function extractFrontmatterAndInlineTags(content: string, lines: string[], section: string): string[] {
  const tagsSet = new Set<string>();

  // 1. Folder-Based Inheritance Fallback (Unified Tagging Strategy v1.0 Part 5)
  const inheritanceMap: Record<string, string> = {
    '00_META': 'meta',
    '01_DSP_&_Audio_Physics': 'dsp',
    '02_Style_Extraction_&_Analysis': 'style-extraction',
    '03_Generative_Rhythm_&_Sequencing': 'generative',
    '04_MUSIC_STUDIES': 'music-studies',
    '05_Jazz_&_Fusion': 'jazz',
    '06_Guitar_Solos_&_Xenochrony': 'guitar',
    '07_Code': 'ea-project'
  };

  const inheritedTag = inheritanceMap[section];
  if (inheritedTag) {
    tagsSet.add(inheritedTag);
  }

  // 2. Extract YAML Frontmatter Tags
  let inFrontmatter = false;
  let inTagsBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        break; // End of frontmatter block
      }
    }

    if (inFrontmatter) {
      // Format A: tags: [tag1, tag2, tag3]
      const inlineArrayMatch = trimmed.match(/^tags:\s*\[(.*?)\]/);
      if (inlineArrayMatch) {
        const parsed = inlineArrayMatch[1]
          .split(',')
          .map(t => t.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
        parsed.forEach(t => tagsSet.add(t));
        continue;
      }

      // Format B: start of multiline list tags:
      if (trimmed.startsWith('tags:')) {
        inTagsBlock = true;
        const afterTags = trimmed.substring(5).trim();
        // If single tag is written inline without brackets: tags: music
        if (afterTags && !afterTags.startsWith('-') && !afterTags.startsWith('[')) {
          tagsSet.add(afterTags.replace(/^['"]|['"]$/g, ''));
          inTagsBlock = false;
        }
        continue;
      }

      // Parse bullet points under tags: block
      if (inTagsBlock) {
        // If we hit another YAML key (e.g. status:, date:, related:), tags block is over
        if (trimmed.includes(':') && !trimmed.startsWith('-')) {
          inTagsBlock = false;
          continue;
        }

        const bulletMatch = trimmed.match(/^-\s*(.+)/);
        if (bulletMatch) {
          tagsSet.add(bulletMatch[1].trim().replace(/^['"]|['"]$/g, ''));
        } else if (trimmed && !trimmed.startsWith('-')) {
          tagsSet.add(trimmed.replace(/^['"]|['"]$/g, ''));
        }
      }
    }
  }

  // 3. Extract Inline Hashtags (fallbacks / cross-references)
  const matches = content.match(/#\w[\w-]+/g);
  if (matches) {
    matches
      .map(t => t.replace('#', ''))
      .filter(t => !/^\d+$/.test(t)) // Filter out numbers-only hashtags
      .slice(0, 10)
      .forEach(t => tagsSet.add(t));
  }

  // 4. Sanitize and Filter Tags (Ensure strict kebab-case and remove anti-patterns)
  const finalTags = [...tagsSet]
    .map(t => t.toLowerCase().replace(/_/g, '-').trim())
    .filter(t => {
      // Remove folder number anti-patterns (e.g. 01planning, 05jazz)
      if (/^\d+/.test(t)) return false;
      return t.length > 1;
    });

  return finalTags;
}

/** Generate excerpt from body text */
function extractExcerpt(lines: string[], title: string, subtitle?: string): string {
  let pastHeaders = false;
  let excerpt = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) { pastHeaders = true; continue; }
    if (trimmed.startsWith('## ') || trimmed.startsWith('### ')) { pastHeaders = true; continue; }
    if (!pastHeaders) continue;
    if (!trimmed || trimmed.startsWith('>') || trimmed.startsWith('|') ||
        trimmed.startsWith('```') || trimmed.startsWith('[') || trimmed.startsWith('-') ||
        trimmed.startsWith('*/') || trimmed.startsWith('*') && !trimmed.startsWith('**')) continue;
    const cleaned = cleanMarkdown(trimmed);
    if (cleaned.length > 20) {
      excerpt += cleaned + ' ';
      if (excerpt.length > 200) break;
    }
  }
  return excerpt.slice(0, 200).trim();
}

/** Recursively scan the vault for all .md files */
function scanVault(root: string): CanonFile[] {
  const files: CanonFile[] = [];
  const ignoreDirs = new Set(['.obsidian', '.git', 'node_modules', '07_Code']);

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !ignoreDirs.has(entry.name)) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const relPath = path.relative(root, fullPath);
        const section = relPath.split(path.sep)[0] || 'root';

        // 1. Gatekeeper: Allowed Sections Check
        if (!DEPLOY_GATE.allowedSections.includes(section) && section !== 'root') {
          continue; // Skip directories not in allowed list
        }

        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        
        // Extract tags early for gate checks
        const fileTags = extractFrontmatterAndInlineTags(content, lines, section);

        // 2. Gatekeeper: Blacklisted Tags Check
        const hasBlockedTag = fileTags.some(tag => DEPLOY_GATE.blockedTags.includes(tag));
        if (hasBlockedTag) {
          continue; // Skip blacklisted drafts/private files
        }

        // 3. Gatekeeper: Whitelisted Tags Check (if enabled)
        if (DEPLOY_GATE.requirePublicWhitelist) {
          const hasWhitelistedTag = fileTags.some(tag => DEPLOY_GATE.whitelistedTags.includes(tag));
          if (!hasWhitelistedTag && !fileTags.includes('public')) {
            continue; // Skip files without public authorization
          }
        }

        const fileTitle = extractTitle(lines);
        const wordCount = content.split(/\s+/).length;
        const isIndex = entry.name.startsWith('_index');

        files.push({
          path: relPath,
          title: fileTitle,
          subtitle: extractSubtitle(lines),
          section,
          size_bytes: stat.size,
          modified: stat.mtime.toISOString(),
          word_count: wordCount,
          excerpt: extractExcerpt(lines, fileTitle),
          tags: fileTags,
          is_index: isIndex,
        });
      }
    }
  }

  walk(root);
  return files;
}

// ── Main ───────────────────────────────────────────────────────

function main() {
  console.log(`\n  \u{1F4C2} Vault: ${VAULT_ROOT}\n`);

  const trackerPath = path.join(VAULT_ROOT, '00_META', 'Project Idea Tracker.md');

  // ─── PROJECTS ────────────────────────────────────────────────
  if (!fs.existsSync(trackerPath)) {
    console.warn('  \u26A0\uFE0F  Vault not found — using pre-committed project data');
    console.warn('     (CI/docker: vault only exists on local machine)');
    process.exit(0);
  }

  const content = fs.readFileSync(trackerPath, 'utf-8');
  const lines = content.split('\n');
  const projects = parseProjectTable(lines);
  const details = parseProjectDetails(lines);
  const detailMap = new Map(details.map((d) => [d.id, d]));
  const merged: Project[] = projects.map((p) => {
    const detail = detailMap.get(p.id);
    return detail ? { ...p, detail } : p;
  });

  const result: ExtractionResult = {
    projects: merged,
    extracted_at: new Date().toISOString(),
    vault_path: VAULT_ROOT,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'projects.json'), JSON.stringify(result, null, 2), 'utf-8');
  console.log(`  \u2705 Extracted ${merged.length} projects`);
  console.log(`     ${merged.filter((p) => p.detail).length} with detail sections`);

  // ─── CANON (FULL VAULT) ──────────────────────────────────────
  const canonFiles = scanVault(VAULT_ROOT);
  const sections = [...new Set(canonFiles.map((f) => f.section))].sort();
  const totalWords = canonFiles.reduce((sum, f) => sum + f.word_count, 0);

  const canonResult: CanonResult = {
    files: canonFiles,
    total_files: canonFiles.length,
    total_words: totalWords,
    sections,
    extracted_at: new Date().toISOString(),
    vault_path: VAULT_ROOT,
  };

  fs.writeFileSync(path.join(OUTPUT_DIR, 'canon.json'), JSON.stringify(canonResult, null, 2), 'utf-8');
  console.log(`  \u2705 Extracted ${canonFiles.length} canonical files`);
  console.log(`     ${totalWords.toLocaleString()} words across ${sections.length} sections`);

  // ─── DAILY SNAPSHOT ──────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dailyFiles = canonFiles.map((f) => ({
    path: f.path,
    title: f.title,
    size_bytes: f.size_bytes,
    modified: f.modified,
  }));

  // Try to get git log for today's changes
  let changeSummary = '';
  try {
    const { execSync } = require('node:child_process');
    changeSummary = execSync(
      `git log --pretty=format:"%h %s" --since="${today} 00:00" --until="${today} 23:59" -- vault/ 2>/dev/null || echo ""`,
      { cwd: path.resolve(VAULT_ROOT, '..'), encoding: 'utf-8', timeout: 5000 }
    ).trim();
  } catch {
    changeSummary = '(git history unavailable in this build context)';
  }

  const snapshot: DailySnapshot = {
    date: today,
    files: dailyFiles,
    change_summary: changeSummary,
  };

  fs.mkdirSync(DAILY_DIR, { recursive: true });
  fs.writeFileSync(path.join(DAILY_DIR, `${today}.json`), JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log(`  \u2705 Saved daily snapshot: ${today}`);

  // ─── SUMMARY ─────────────────────────────────────────────────
  console.log(`\n  \u{1F4C4} Outputs:`);
  console.log(`     projects.json  — ${merged.length} projects`);
  console.log(`     canon.json     — ${canonFiles.length} files (${totalWords.toLocaleString()} words)`);
  console.log(`     daily/${today}.json — daily snapshot`);
  console.log(`  \u{1F550} ${new Date().toISOString()}\n`);
}

// Wrap in try-catch so parse errors don't block CI builds
try {
  main();
} catch (err) {
  console.warn('  \u26A0\uFE0F  Extraction error — using pre-committed data');
  console.warn(`     ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
}
