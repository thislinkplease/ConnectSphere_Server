const { createClient } = require('@supabase/supabase-js')
const dotenv = require('dotenv')
dotenv.config()

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing Supabase configuration in .env')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)
console.log('✅ Supabase client initialized successfully')

module.exports = { supabase }
