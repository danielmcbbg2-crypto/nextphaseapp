/**
 * Stops a live build that has no Supabase settings. Without them the site would silently run in demo
 * mode (sample accounts sharing one well-known password) instead of the real database.
 */
export function missingSupabaseSettings(
  env: Record<string, string | undefined>,
  mode: string,
): string | null {
  if (mode === 'demo' || mode === 'single-file' || mode === 'development') return null
  if (env.VITE_DEMO === 'true' || env.ALLOW_UNCONFIGURED_BUILD === 'true') return null
  const missing = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'].filter((k) => !env[k]?.trim())
  return missing.length
    ? `Build stopped: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set, so the live site would run in demo mode. ` +
        'Set them (Netlify: Site configuration → Environment variables), or build with VITE_DEMO=true for a demo.'
    : null
}
