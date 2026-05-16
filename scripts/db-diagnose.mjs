import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

// Load env vars from common locations (no dotenv dependency required)
const ENV_PATHS = ['.env.local', '.env', 'apps/web/.env.local'];
for (const path of ENV_PATHS) {
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}

if (!process.env.SUPABASE_DB_URL) {
  console.error('✗ SUPABASE_DB_URL not set in environment or .env.local');
  process.exit(1);
}

const MIGRATIONS_DIR = 'packages/db/supabase/migrations';
const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

const PATTERNS = {
  table:     /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/gi,
  view:      /create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?(\w+)/gi,
  function:  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(/gi,
  extension: /create\s+extension\s+(?:if\s+not\s+exists\s+)?["']?(\w+)["']?/gi,
};

const expected = []; // { migration, kind, name }
for (const file of files) {
  const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  for (const [kind, pattern] of Object.entries(PATTERNS)) {
    for (const m of content.matchAll(pattern)) {
      expected.push({ migration: file, kind, name: m[1] });
    }
  }
}

const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: 'require' });

try {
  const presentTables = new Set((await sql`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
  `).map(r => r.table_name));
  const presentViews = new Set((await sql`
    SELECT table_name FROM information_schema.views WHERE table_schema = 'public'
  `).map(r => r.table_name));
  const presentFunctions = new Set((await sql`
    SELECT proname FROM pg_proc
    WHERE pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  `).map(r => r.proname));
  const presentExtensions = new Set((await sql`
    SELECT extname FROM pg_extension
  `).map(r => r.extname));

  const presence = {
    table: presentTables,
    view: presentViews,
    function: presentFunctions,
    extension: presentExtensions,
  };
  const missing = expected.filter(o => !presence[o.kind].has(o.name));

  if (missing.length) {
    console.error(`✗ ${missing.length} of ${expected.length} schema objects missing from production Supabase:\n`);
    const byMigration = {};
    for (const m of missing) {
      (byMigration[m.migration] ||= []).push(`  ${m.kind}: ${m.name}`);
    }
    for (const [migration, items] of Object.entries(byMigration)) {
      console.error(`${migration}`);
      console.error(items.join('\n'));
      console.error('');
    }
    console.error('Apply the missing migration(s) via the Supabase SQL editor before proceeding.');
    process.exit(1);
  }
  console.log(`✓ All ${expected.length} expected schema objects present in production Supabase.`);
} finally {
  await sql.end();
}