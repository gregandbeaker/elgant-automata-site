/**
 * Vault Extraction Script
 *
 * Reads the Elegant Automata Obsidian vault and generates structured data
 * for the Astro landing page at build time.
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
    'Library/Mobile Documents/iCloud~md~obsidian/Documents/Elegant Automata'
  );

const OUTPUT_DIR = path.resolve(__dirname, '..', 'src', 'data');

// Status emoji → machine-readable status
const STATUS_MAP: Record<string, string> = {
  '🟢': 'initiated',
  '🟡': 'planned',
  '🟠': 'active',
  '🔴': 'blocked',
  '✅': 'complete',
  '⬜': 'pending',
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

// ── Helpers ────────────────────────────────────────────────────

/** Strip markdown bold markers and wiki links */
function cleanMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1') // bold → plain
    .replace(/\[\[(.*?)\]\]/g, '$1') // [[link]] → text
    .replace(/\[(.*?)\]\(.*?\)/g, '$1') // [text](url) → text
    .replace(/\|(.*?)$/g, '') // [[link|alias]] → alias
    .trim();
}

/** Extract status from emoji + word in table cell */
function parseStatus(cell: string): string {
  for (const [emoji, status] of Object.entries(STATUS_MAP)) {
    if (cell.includes(emoji)) return status;
  }
  return 'pending';
}

/** Parse the Active Experiments Dashboard table */
function parseProjectTable(lines: string[]): Project[] {
  const projects: Project[] = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect table header
    if (trimmed.startsWith('| ID | Project') && trimmed.includes('Status')) {
      inTable = true;
      continue;
    }

    // Skip separator line
    if (inTable && /^\| :?-+/.test(trimmed)) continue;

    // Empty line ends the table
    if (inTable && trimmed === '') break;

    // Skip non-table lines
    if (!inTable || !trimmed.startsWith('| **')) continue;

    // Parse row: split by |, trim each cell
    const cells = trimmed
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);

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

/** Parse project detail sections (## 🧬 EXP-01: The Album Generator, etc.) */
function parseProjectDetails(lines: string[]): ProjectDetail[] {
  const details: ProjectDetail[] = [];
  let current: Partial<ProjectDetail> | null = null;
  let collectingDescription = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match section headers like "## 🧬 EXP-01: The Album Generator"
    const headerMatch = line.match(
      /^##\s+.+?\s+(EXP-\d+|DISC-\d+):\s+(.+)$/
    );

    if (headerMatch) {
      // Save previous
      if (current && current.id) {
        details.push(current as ProjectDetail);
      }

      current = {
        id: headerMatch[1],
        title: headerMatch[2].trim(),
        subtitle: '',
        description: '',
      };

      // Check next line for ### subtitle
      if (lines[i + 1] && lines[i + 1].startsWith('###')) {
        current.subtitle = lines[i + 1]
          .replace(/^###\s*/, '')
          .replace(/\*/g, '')
          .trim();
        i++; // skip the subtitle line
      }

      collectingDescription = false;
      continue;
    }

    // Skip the italic tagline "(Or: ...)"
    if (
      current &&
      !collectingDescription &&
      line.trim().startsWith('*(')
    ) {
      collectingDescription = true;
      continue;
    }

    // Skip sub-headers and metadata while collecting
    if (
      current &&
      collectingDescription &&
      !current.description
    ) {
      // Skip lines we don't want as description
      if (
        !line.trim() ||
        line.startsWith('#') ||
        line.startsWith('|') ||
        line.startsWith('```') ||
        line.startsWith('>') ||
        line.startsWith('-') ||
        line.startsWith('![')
      ) {
        continue;
      }

      const cleaned = line
        .replace(/\*\*/g, '')
        .replace(/\[\[(.*?)\]\]/g, '$1')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .trim();

      if (cleaned.length > 50) {
        current.description = cleaned;
        collectingDescription = false;
      }
    }
  }

  // Save last one
  if (current && current.id) {
    details.push(current as ProjectDetail);
  }

  return details;
}

// ── Main ───────────────────────────────────────────────────────

function main() {
  console.log(`\n  📂 Vault: ${VAULT_ROOT}\n`);

  const trackerPath = path.join(
    VAULT_ROOT,
    '00_META',
    'Project Idea Tracker.md'
  );

  if (!fs.existsSync(trackerPath)) {
    console.error(`  ❌ Project Idea Tracker not found at: ${trackerPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(trackerPath, 'utf-8');
  const lines = content.split('\n');

  // Parse
  const projects = parseProjectTable(lines);
  const details = parseProjectDetails(lines);

  // Merge details into projects
  const detailMap = new Map(details.map((d) => [d.id, d]));
  const merged: Project[] = projects.map((p) => {
    const detail = detailMap.get(p.id);
    return detail ? { ...p, detail } : p;
  });

  // Build result
  const result: ExtractionResult = {
    projects: merged,
    extracted_at: new Date().toISOString(),
    vault_path: VAULT_ROOT,
  };

  // Write
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const outputPath = path.join(OUTPUT_DIR, 'projects.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');

  console.log(`  ✅ Extracted ${merged.length} projects`);
  console.log(`     ${merged.filter((p) => p.detail).length} with detail sections`);
  console.log(`  📄 Output: ${outputPath}`);
  console.log(`  🕐 ${result.extracted_at}\n`);
}

main();
