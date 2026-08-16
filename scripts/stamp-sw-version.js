/**
 * Build-time script for Vercel static deployments.
 *
 * Browsers only detect a new service worker by comparing the raw bytes
 * of service-worker.js against whatever is currently installed. An
 * ordinary deploy only touches index.html/app.js/style.css -- it never
 * touches service-worker.js itself -- so that file's bytes stay
 * identical across deploys and the browser never notices anything
 * changed. That silently pins an already-open or installed session on a
 * stale cached version indefinitely: the entire update pipeline already
 * wired up in service-worker.js and app.js (skipWaiting -> activate ->
 * clients.claim -> the 'controllerchange' listener -> the "new version
 * available" banner) never fires, because as far as the browser can
 * tell, there IS no new version.
 *
 * This stamps a fresh, deploy-unique CACHE_VERSION into service-worker.js
 * at build time using Vercel's own commit SHA, so the file's bytes
 * genuinely differ on every single deploy and the browser's normal
 * update-check always finds a real difference. Falls back to a
 * timestamp when VERCEL_GIT_COMMIT_SHA isn't set (e.g. a local run),
 * which still guarantees a different value on every run.
 */
const fs = require('fs');
const path = require('path');

const swPath = path.join(__dirname, '..', 'service-worker.js');
const buildId = process.env.VERCEL_GIT_COMMIT_SHA || `local-${Date.now()}`;

const original = fs.readFileSync(swPath, 'utf8');
const versionLinePattern = /^const CACHE_VERSION = '.*';$/m;

if (!versionLinePattern.test(original)) {
  console.error(
    '[stamp-sw-version] Could not find "const CACHE_VERSION = \'...\';" in service-worker.js -- ' +
    'aborting the build rather than silently shipping an unstamped service worker.'
  );
  process.exit(1);
}

const stamped = original.replace(versionLinePattern, `const CACHE_VERSION = '${buildId}';`);
fs.writeFileSync(swPath, stamped);
console.log(`[stamp-sw-version] Stamped service-worker.js CACHE_VERSION = ${buildId}`);
