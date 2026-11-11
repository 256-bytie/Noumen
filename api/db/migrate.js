// Forward-only SQL migration runner.
// Usage: npm run migrate   (reads DATABASE_URL from .env)
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set (copy .env.example to .env)');
    process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
    await client.connect();
    // One runner at a time
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name       text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
        )
    `);

    const done  = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const files = (await readdir(dir)).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();

    let applied = 0;
    for (const file of files) {
        if (done.has(file)) continue;
        const sql = await readFile(path.join(dir, file), 'utf8');
        console.log(`apply ${file}`);
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        applied++;
    }
    console.log(applied ? `applied ${applied} migration(s)` : 'up to date');
} catch (err) {
    console.error(`migration failed: ${err.message}`);
    process.exitCode = 1;
} finally {
    await client.end();
}
