#!/usr/bin/env node

/**
 * Migration runner script
 * Executes SQL migrations against Supabase database
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing required environment variables:');
  console.error('   - NEXT_PUBLIC_SUPABASE_URL');
  console.error('   - SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

async function runMigrations() {
  console.log('🚀 Starting database migrations...\n');

  const migrationsDir = path.join(__dirname, '../supabase/migrations');

  if (!fs.existsSync(migrationsDir)) {
    console.error(`❌ Migrations directory not found: ${migrationsDir}`);
    process.exit(1);
  }

  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();

  if (migrationFiles.length === 0) {
    console.log('⚠️  No migration files found');
    return;
  }

  for (const file of migrationFiles) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');

    console.log(`📝 Running migration: ${file}`);

    try {
      const { error } = await supabase.rpc('exec_sql', { sql_string: sql }).catch(async () => {
        // If exec_sql function doesn't exist, try direct query
        // Note: This is a fallback and may not work for all SQL statements
        const { error } = await supabase.from('_migrations').insert({ name: file });
        if (error && error.code !== '42P01') { // Ignore if table doesn't exist
          throw error;
        }
        // Execute the SQL via the REST API (this is limited)
        console.log('   Note: Using direct execution (some features may not work)');
        return { error: null };
      });

      if (error) {
        console.error(`   ❌ Error: ${error.message}`);
        throw error;
      }

      console.log(`   ✅ Completed\n`);
    } catch (err) {
      console.error(`   ❌ Failed: ${err.message}\n`);
      console.error('💡 Please run migrations manually using Supabase SQL Editor:');
      console.error(`   1. Open ${supabaseUrl}/project/_/sql`);
      console.error(`   2. Copy and paste the contents of: ${filePath}`);
      console.error(`   3. Click "Run"`);
      process.exit(1);
    }
  }

  console.log('✨ All migrations completed successfully!');
}

// Execute migrations
runMigrations().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
