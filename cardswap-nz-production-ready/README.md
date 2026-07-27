# CardSwap NZ

A vanilla HTML, CSS, and JavaScript single-page app for buying and selling discounted gift cards, backed by Supabase (Auth, Postgres, RLS). No build tooling or frontend framework is required to run the app itself — the only build step is generating `env-config.js` from environment variables at deploy time.

## Project structure

```
.
├── index.html                          # App shell, all page sections, routing targets
├── style.css                           # All styling
├── app.js                              # All application logic (routing, auth, listings, checkout, dashboards)
├── supabase-client.js                  # Initializes window.supabaseClient from window.SUPABASE_URL / window.SUPABASE_ANON_KEY
├── env-config.example.js               # Template showing the shape of the generated env-config.js
├── scripts/
│   └── generate-env.js                 # Build-time script: writes env-config.js from process.env
├── 20260724150000_init_cardswap_schema.sql   # Supabase/Postgres schema, RLS policies, triggers
├── vercel.json                         # Vercel build command + output directory
├── package.json                        # Declares the build script for Vercel
├── .gitignore                          # Excludes the generated env-config.js
└── README.md
```

## How configuration works

Vercel does **not** inject dashboard Environment Variables into static client-side files automatically — those variables are only available to the build process and to serverless functions. This project has neither a bundler nor a serverless function, so `scripts/generate-env.js` runs as the Vercel **build command** and writes a plain JS file, `env-config.js`, containing:

```js
window.SUPABASE_URL = "...";
window.SUPABASE_ANON_KEY = "...";
```

`index.html` loads `env-config.js` *before* `supabase-client.js`, so by the time `supabase-client.js` runs, `window.SUPABASE_URL` and `window.SUPABASE_ANON_KEY` are already defined and `createClient()` is called with real values.

`env-config.js` is generated fresh on every build and is excluded from git via `.gitignore` — it should never be committed.

## Deploying to Vercel

1. Push this repository to GitHub.
2. In Vercel, import the GitHub repo as a new project.
3. Framework Preset: **Other** (no framework detected is expected — that's correct for a vanilla app).
4. In **Project Settings → Environment Variables**, add for both Production and Preview:
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_ANON_KEY` — your Supabase anon/public key
5. Deploy. Vercel will run `node scripts/generate-env.js` (via `vercel.json`) before serving the app, generating `env-config.js` automatically.
6. Open the deployed URL. The app should load with no "Supabase client is not configured" error.

If `SUPABASE_URL` or `SUPABASE_ANON_KEY` are missing, the build will **fail intentionally** with a clear error message rather than deploying a broken app.

## Database setup

Run `20260724150000_init_cardswap_schema.sql` against your Supabase project (via the Supabase SQL editor or CLI) to create the `profiles`, `submissions`, `card_vault`, `listings`, and `orders` tables, along with RLS policies, triggers, and the `handle_new_user` trigger that auto-creates a profile row on signup.

## Local development

Since there's no dev server or bundler, you can serve the folder with any static file server after generating `env-config.js`:

```bash
# Option A: generate it via the script
SUPABASE_URL="https://your-project.supabase.co" SUPABASE_ANON_KEY="your-anon-key" node scripts/generate-env.js

# Option B: copy the example and fill in real values
cp env-config.example.js env-config.js

# Then serve the folder, e.g.:
npx serve .
```

`env-config.js` is gitignored, so this step is required on every fresh clone / local checkout.
