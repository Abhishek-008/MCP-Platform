import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// This client is safe to use in the Browser and Server Components
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// --- OPTIONAL: Admin Client ---
// Only use this in API Routes or Server Actions (never client-side)
// to bypass Row Level Security (RLS) if needed.
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
export const supabaseAdmin = supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : null