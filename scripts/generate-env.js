/**
 * Build-time script for Vercel static deployments.
 *
 * Vercel does not inject dashboard Environment Variables into static
 * client-side files automatically -- it only exposes them to the build
 * process (this script) and to serverless functions. Since this project
 * has no serverless functions and no bundler, we bridge the gap by
 * writing the values to a plain JS file (env-config.js) during the
 * build step. That file is loaded by index.html before supabase-client.js,
 * which reads window.SUPABASE_URL / window.SUPABASE_ANON_KEY.
 */
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    '[generate-env] Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variable(s). ' +
    'Set them in Vercel Project Settings -> Environment Variables (Production and Preview).'
  );
  process.exit(1);
}

const outputPath = path.join(__dirname, '..', 'env-config.js');

const contents =
  '// AUTO-GENERATED at build time by scripts/generate-env.js. Do not edit or commit.\n' +
  `window.SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)};\n` +
  `window.SUPABASE_ANON_KEY = ${JSON.stringify(SUPABASE_ANON_KEY)};\n`;

fs.writeFileSync(outputPath, contents);
console.log(`[generate-env] Wrote ${outputPath}`);
