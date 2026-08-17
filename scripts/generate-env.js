/**
 * Build-time script for Vercel static deployments.
 *
 * Vercel does not inject dashboard Environment Variables into static
 * client-side files automatically -- it only exposes them to the build
 * process (this script) and to serverless functions (the api/ folder
 * reads its own env vars directly via process.env, no build step needed
 * for those). This script exists specifically to bridge the gap for the
 * CLIENT-side Supabase config, since there's no bundler here to inject
 * env vars into browser JS -- it writes the values to a plain JS file
 * (env-config.js) during the build step. That file is loaded by
 * index.html before supabase-client.js, which reads
 * window.SUPABASE_URL / window.SUPABASE_ANON_KEY. It also stamps
 * window.GIFTLIO_BUILD_ID (read by app.js to fill in the footer's
 * #buildMarker) with the same deploy-unique commit SHA used for the
 * service worker's CACHE_VERSION.
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

// Same deploy-unique identifier scripts/stamp-sw-version.js uses for
// CACHE_VERSION, reused here for a visible on-page build marker (footer
// #buildMarker) -- lets a real device be checked, at a glance, against
// what commit it's actually running, both for this PWA-update test and
// for any future "is this user actually on the latest deploy" question.
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA || `local-${Date.now()}`;

const contents =
  '// AUTO-GENERATED at build time by scripts/generate-env.js. Do not edit or commit.\n' +
  `window.SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)};\n` +
  `window.SUPABASE_ANON_KEY = ${JSON.stringify(SUPABASE_ANON_KEY)};\n` +
  `window.GIFTLIO_BUILD_ID = ${JSON.stringify(BUILD_ID)};\n`;

fs.writeFileSync(outputPath, contents);
console.log(`[generate-env] Wrote ${outputPath}`);
