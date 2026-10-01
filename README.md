# Social Risk Coding Workspace

A self-hostable application for reading the harmonized social-risk responses and developing a codebook. The form centers on Behavior, optional Who is involved and Setting codes, and one Observations box.

## Start reading locally

The local preview runs at http://127.0.0.1:4317. Click **Open local workspace**. On this Mac, double-click `start-preview.command` to restart it after the current preview stops. Keep its terminal running. If another copy is already running, use the existing browser page instead of starting a second process.

With Node.js 24.4 or later in the 24.x series:

```sh
cd "/path/to/Qualitative coding app"
node manage.mjs import "../Combined data/social_risk_combined_analysis.csv"
node server.mjs --preview
```

The app has no third-party JavaScript dependencies and no separate frontend build. It uses Node's built-in HTTP server, crypto, and SQLite APIs. Its Node 24 requirement is deliberate; do not use an older Node version. [Node SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

Local preview is restricted to loopback and is for the computer's owner. It creates a local researcher identity; it is not the authentication mode to expose to RAs. Production rejects the preview flag.

## Reading workflow

1. Filter by general/social, self/others, approach/avoid, or your own review status. Search response text or participant labels. Blank answers are hidden initially but can be included.
2. Read the original, unmodified response. Expand the question/source or the other seven responses in the same survey record when helpful. Displayed question wording is explicitly labeled as a summary.
3. Choose concrete **Behavior** codes, including actions considered or avoided. Multiple codes may fit. The 58 provisional behavior codes are organized into 12 broad categories. Choose a broad category first, then an individual behavior. You can add behaviors from multiple categories. The guide expands one category at a time. New code is available before choosing a category. In its dialog, choose an existing broad category or add a new category, then enter the behavior name. The current category is preselected when available. Saving adds the behavior and any new category to the shared pool.
4. Optionally code **Who is involved?** and **Setting**, using only stated context. There are nine starting relationship codes and eight setting codes. Leave unspecified information empty or select Unspecified.
5. Use **Observations** for context-dependent meanings, contradictions, alternative actions, or explicitly stated stakes worth retaining. There are no evidence dropdowns or separate loss, benefit, reason, decision, or outcome fields.
6. Notes autosave after a short pause. **Needs discussion** flags the response in your queue. **Complete & next** marks your reading complete, not the team's consensus. Alt+Left/Right navigates the current queue.

The starting vocabulary was informed by an exploratory reading of 400 responses, 50 from each prompt. It is provisional, not a frequency analysis, and no responses are automatically coded. “Asking a question” applies whether the respondent asked or chose not to ask.

Existing coding is preserved: former dimensions, evidence selections, descriptions, excerpts, and memo fields remain in the database and exports. The old Situation dimension mixed people and settings, so it is not automatically mapped to the new fields. Untouched broad starter behaviors are retired from new selections; their IDs and prior assignments remain intact. User-created and revised behavior codes are retained.

An answer under “approach” may describe avoidance. General risk may include social risk. “Others” answers describe perceived peer behavior. The app preserves the prompt separately from your interpretation. It does not infer motives, generate annotations, or perform AI coding.

## Load the starter categories on a new server

After creating the administrator, run:

```sh
docker compose exec coding node manage.mjs seed-codebook lab-admin
# Without Docker: node manage.mjs seed-codebook lab-admin
```

This inserts the 75 starting categories as drafts and records their provenance in the revision history. It is safe to repeat: existing definitions and edits are preserved, including renamed starter codes. It does not assign codes to responses. The local workspace already has these categories loaded.

## Shared codebook and team behavior

- Each account has independent annotations and progress. An RA cannot retrieve or overwrite another RA's annotations through the API. All researchers see the same responses and shared codebook; assignment-based restrictions are not implemented.
- The reading dimension is supplied automatically. For a new behavior, choose or create a broad category and enter the behavior name. Other dimensions ask only for a code name. Saving adds the code to that dimension’s shared category pool immediately, without assigning it to the current response. In the Codebook view, select a dimension before adding a code. Researchers may rename their own new codes, and administrators may rename any code. Older codebook entries are retained in exports. Code lifecycle metadata remains internal and in exports; there is no status field in the entry form.
- A code's dimension cannot change after creation. Create a new code for a different dimension. There is no destructive code deletion or automatic code merging.
- Concurrent edits are version-checked. A conflicting save is rejected rather than silently overwriting the other edit. The page retains unsaved text and asks you to copy it before reloading. Failed network saves also retain text in the open page, but this is not an offline app; do not close an unsaved page.
- Administrators can add accounts in **Team**, inspect completion counts, export all annotations, and export the revision history. Team adjudication and side-by-side coder comparison are not included in this first version; use the exports for that stage.
- All annotation saves and code edits create history entries. CSV exports use current code labels; the JSON history retains earlier definitions and annotation versions.
- Progress includes all imported response slots, including blanks, so the denominator is 5,264 for this dataset. The initial reading queue contains 5,075 nonblank responses. “NA” and similar participant-entered strings are retained as text for a researcher to classify.

## Hosting on your server

Yes: a single Linux server capable of running Docker or Node.js 24 can run this app. RAs only need a browser. It uses one application process and a persistent SQLite database, suitable as a starting architecture for a small lab team. No cloud database, external authentication service, or paid hosting platform is required. Large-team load testing has not been performed.

Use a dedicated hostname such as `https://coding.your-lab.edu`. This version expects deployment at the hostname root, not at a URL subpath. Configure `APP_ORIGIN` to that exact origin, without a trailing slash. It is used to check write requests, and HTTPS enables secure cookies.

### Docker deployment

1. Copy this application's source directory to your server. Do not publish the source dataset or database in a public web directory. The Docker image intentionally excludes data, input files, and secrets.
2. Put the harmonized CSV in `input/social_risk_combined_analysis.csv` beside `compose.yaml`.
3. Copy `.env.example` to `.env` and set the actual HTTPS origin.
4. Run:

```sh
docker compose up -d --build
docker compose exec coding node manage.mjs import /input/social_risk_combined_analysis.csv
```

5. Create your first administrator. In a Bash shell, these commands read the password without displaying it or placing it in shell history:

```bash
read -r -s -p "Administrator password (12+ characters): " coding_password
printf '\n'
printf '%s' "$coding_password" | docker compose exec -T coding node manage.mjs add-user lab-admin admin "Lab administrator"
unset coding_password
```

6. Configure your existing HTTPS reverse proxy to forward the hostname to `127.0.0.1:4317` on the server. `Caddyfile.example` supplies a minimal example for a Caddy instance running on the host. Caddy can provision certificates when DNS and network access are configured correctly. [Caddy HTTPS guide](https://caddyserver.com/docs/quick-starts/https) and [reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
7. Sign in as the administrator and add RA accounts from **Team**. Give each RA their own username and password privately.

The Compose file publishes the app port only to the server's loopback address; the HTTPS proxy is the public entry point. Do not expose `--preview` or forward the local-preview server to the internet. There are no public registration or password-recovery endpoints. Passwords are salted and hashed, session cookies are HttpOnly and SameSite=Strict, sessions expire after 12 hours, and write requests require an origin and session CSRF token. Login failures are rate-limited. Researcher access should still follow your lab's data-access procedures.

### Run without Docker

Keep data on server-local storage and run the process as a dedicated, unprivileged service account. Use a process manager such as systemd. Set:

```sh
export NODE_ENV=production
export APP_ORIGIN=https://coding.your-lab.edu
export DB_PATH=/var/lib/social-risk-coding/coding.sqlite
export HOST=127.0.0.1
export PORT=4317
node manage.mjs import /private/path/social_risk_combined_analysis.csv
# Create the initial administrator using the same stdin pattern as above,
# replacing the Docker command with: node manage.mjs add-user lab-admin admin
node server.mjs
```

Create the database directory with ownership restricted to the service account before running. Use the same `DB_PATH` for management and server commands. Keep the SQLite database on one machine's local disk, not an NFS share or a live Google Drive/Dropbox synchronization folder. The app directory in this workspace is for development; the Docker volume is the recommended server data location. Never run several deployed copies against separately synchronized database files.

### Backups and account management

Use the backup command to make a consistent snapshot, including committed data in SQLite's write-ahead log. Do not copy only the live `.sqlite` file while it is running.

```sh
docker compose exec coding node manage.mjs backup /app/data/backup-2026-10-01.sqlite
docker compose cp coding:/app/data/backup-2026-10-01.sqlite ./backup-2026-10-01.sqlite
```

Use a new filename for each backup. Store copies securely off-server and test restoring them. To restore, stop the application, preserve the current database files as a rollback copy, replace the database with a snapshot in an otherwise clean data directory, set its service-account ownership, and restart. Do not leave old `-wal` or `-shm` files beside a restored database. Backups include response text, annotations, account hashes, and session data.

```sh
# Disable an account and revoke sessions:
docker compose exec coding node manage.mjs disable-user ra-name
# Reset a password using the stdin pattern above:
# ... | docker compose exec -T coding node manage.mjs reset-password ra-name
```

Import is idempotent: repeating an unchanged import does not duplicate responses or discard annotations. Changed existing responses abort the whole import. New records append, keeping stable response IDs. Removed rows in an incoming file are not deleted from the database. The source CSV and preprocessing RMD are never modified by this app.

## Export and data model

- `responses`: immutable imported text and selected source metadata, keyed by analysis response key plus prompt.
- `annotations`: one current annotation per response/account, with status and version.
- `codes`: shared draft/active/retired definitions with stable IDs and versions.
- `history`: previous saved annotations and code edits.
- `users` / `sessions`: account and session records.

**Export my annotations** and **Export team annotations** include only saved annotations, not every unread response. They include source keys so they can be joined back to the harmonized CSV. Code IDs and names are JSON arrays in CSV cells to avoid delimiter ambiguity. Exports neutralize formula-like strings by prefixing an apostrophe for spreadsheet safety; the database retains the original text exactly. The revision-history JSON is an audit export, not a database backup.

## Verification

```sh
npm test
```

Tests use temporary synthetic data and exercise imports, exact text preservation, source-change rollback, authentication, CSRF/origin checks, separate coder annotations, conflicting saves, excerpt validation, code permissions, filters, account creation, logout, and exports. Browser checks cover the reading and codebook flows and responsive layouts. Docker deployment and your server's proxy configuration must still be verified on the actual server.

## Render deployment

`render.yaml` provisions one 512 MB web service and a 1 GB persistent disk. Keep the workspace on Hobby. The app uses Render's HTTPS `RENDER_EXTERNAL_URL` automatically; set `APP_ORIGIN` only if switching to a custom domain. The disk is mounted at `/var/data`, and `DB_PATH` points there. No data or accounts are embedded in the repository. Transfer a consistent database backup separately before inviting researchers, and set a usable administrator password via the management CLI. Revoke migrated sessions. Do not use preview mode on Render.
