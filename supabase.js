// supabase.js
require('dotenv').config(); // Ensures environment variables are accessible
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables!");
  process.exit(1);
}

// Initialize the single, shared Supabase client instance
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Export the instance so other files can import and use it
module.exports = supabase;