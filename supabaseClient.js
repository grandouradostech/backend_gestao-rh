require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

console.log('[DEBUG] SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('[DEBUG] SUPABASE_KEY:', process.env.SUPABASE_KEY ? 'OK' : 'MISSING');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);
module.exports = supabase; 