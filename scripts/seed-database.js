#!/usr/bin/env node

/**
 * Database seed script
 * Populates database with sample data for testing
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

async function seedDatabase() {
  console.log('🌱 Starting database seed...\n');

  const seedFile = path.join(__dirname, '../supabase/seed.sql');

  if (!fs.existsSync(seedFile)) {
    console.error(`❌ Seed file not found: ${seedFile}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(seedFile, 'utf8');

  console.log('📝 Executing seed script...');

  try {
    // Note: Direct SQL execution via Supabase client is limited
    // For complex seed scripts, use the Supabase SQL Editor
    console.log('\n💡 To seed the database:');
    console.log(`   1. Open ${supabaseUrl}/project/_/sql`);
    console.log(`   2. Copy and paste the contents of: ${seedFile}`);
    console.log(`   3. Click "Run"`);
    console.log('\n   Or use psql directly with your connection string');

    // Verify we can connect and check if data exists
    const { count, error } = await supabase
      .from('tenants')
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.error(`\n❌ Error connecting to database: ${error.message}`);
      process.exit(1);
    }

    console.log(`\n📊 Current tenant count: ${count || 0}`);
    console.log('✨ Use the instructions above to run the seed script');

  } catch (err) {
    console.error(`❌ Failed: ${err.message}`);
    process.exit(1);
  }
}

// Execute seed
seedDatabase().catch(err => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
