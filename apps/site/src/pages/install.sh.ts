import type { APIRoute } from 'astro'
// The repo-root script, also served by unpkg from the npm package; one copy for both
import script from '../../../../install.sh?raw'

export const GET: APIRoute = () => new Response(script)
