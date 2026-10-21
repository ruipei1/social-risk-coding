# Social Risk Coding Workspace

## Current vocabulary: behavior-flat-v7

Behavior starts with a single, flat list of 19 labels; coders can add shared draft behavior codes. Other behavior appears last in the selector. Exact names, definitions, inclusion rules, and exclusion rules live in `behavior-vocabulary.mjs`; this is the authoritative versioned vocabulary. The reading selector, guide, codebook and administrator comparison editor show no higher-level behavior categories. Existing behavior names and definitions are protected through the code API and UI. New behavior codes have no higher-level category, and existing or retired names cannot be reintroduced. Use Other behavior with a short observation for a clearly described action outside the vocabulary. Consequences, people, settings, response type, and researcher-added nonbehavior labels remain unchanged and editable.

Code the action done, considered, or avoided independently of the survey's Approach/Avoid prompt. Nonparticipation is not automatically a refusal. Online communication and AI are media, not behavior categories: code their stated function. Using or avoiding AI for assignments, cheating, or honor-code concerns is Making an education or work decision; do not infer a function that is not stated. Public participation versus assistance-seeking, nonromantic invitations versus romantic initiation, and ordinary exercise versus challenge are explained in the label guide. Multiple labels require distinct stated actions.

## Behavior migration and review

`behavior-migration.mjs` inventories **every actual behavior record**, including edited, researcher-added and retired records. `seedStarterCodebook` invokes the v7 migration, never the earlier consolidation routines. A legacy vocabulary receives the full flat-vocabulary migration; an existing v6 database receives only the targeted v7 definition update, preserving researcher-added behavior codes and every annotation. Startup applies v7 before listening for requests. It is transactional and records the version only after success; rerunning an applied version leaves codebook, annotations and history unchanged.

Before mutating a disk database the migration uses SQLite `VACUUM INTO` to create a consistent snapshot beside it, including committed WAL contents. The filename is unique, contains the target vocabulary version, and has owner-only permissions. Backup failure aborts startup. This snapshot includes research data and account/session records: keep it private, copy it securely off-server, and never commit it to GitHub. The in-memory test database has no backup file.

Superseded choices are retired; their IDs, names, definitions, and category metadata are retained. An existing record with an exact canonical name is reused, with its full previous definition and category saved to `code_before_flat_migration` history before adopting the canonical definition. All coder/batch selections are remapped and deduplicated. Each affected annotation gains a version and a history entry containing previous payload, new payload, mapping decisions, coder, batch and unchanged status. Original response text, all nonbehavior coding, notes, evidence, response type, coder/batch ownership, and completion/discussion statuses are preserved. Before/after hashes in the migration manifest verify preservation of responses, stable annotation content, nonbehavior code records, and preexisting history.

Context-sensitive and unknown/edited labels are **not guessed from keywords**. For instance, Sharing opinions may contain a public performance inherited from an earlier merge; Asking for contact information need not be romantic. Those assignments retain the retired code and get a separate `behavior_reviews` record carrying original response, previous annotation and relevant earlier history. Other to discuss becomes a migration review flag, never an automatic Other behavior assignment. Retained legacy selections cannot be newly added to another reading.

Administrators open **Team → Vocabulary migration report and review assignments** (`/migration-review`). The report includes backup path, preservation hashes, complete old-to-new mapping, exact canonical definitions, and every unresolved assignment. An administrator can resolve a review using the original response and history, choose zero or more canonical replacements, and record the evidence. Resolution is version-checked and transactional, preserves notes/status, and writes `annotation_migration_review` history. It may reconcile a past batch without opening that batch for ordinary edits. Unresolved flags remain visible in the reading room and annotation CSV export, independently of completion status. A normal coding edit does not silently clear migration flags.

`GET /api/codebook-version` requires sign-in and returns the version plus exact selectable names/definitions. `GET /api/behavior-migration` and its resolution endpoint require an administrator. `/health` returns application vocabulary version and Render commit metadata without research data. Verify actual live labels and the migration report, not `/health` alone.

## Reading and team workflow

The imported dataset has 658 survey records / 5,264 response slots, including 5,075 nonblank responses. Responses are immutable. Filters separate domain, perspective, prompt and reading status. Coders have independent annotations within each batch; shared codebook access does not permit retrieving another coder's readings. Notes autosave; Complete & next advances the queue. Network/conflict failures retain unsaved text in the page: do not close it before recovering your work. This is not an offline app.

Only administrators create coding batches. Every coder may select batches. Starting a batch preserves previous work and makes previous batches read-only; a selected starting participant rotates the queue. Exports include all saved batches and coder/batch identifiers. The codebook is shared across batches.

Compare coders is administrator-only and assesses agreement solely from exact behavior-code sets, using completed, overlapping readings for the 80% calibration threshold. Consequence, who, setting, response type, and observations remain visible for discussion but never affect agreement badges, filters, summaries, or pass/fail status. Coder selection and provisional behavior comparisons remain available. Missing or unfinished readings are not behavior disagreements. Administrative corrections in the current batch use optimistic versions and revision history. No separate consensus/adjudication flag is stored. Assignment-based restrictions are not implemented.

Anticipated interpersonal consequence includes mutually exclusive `Unspecified` and named choices. Use `Unspecified` only when an interpersonal consequence is implied but its type is not stated; leave the dimension empty when no consequence is supported. Use `Other` for a specific stated consequence outside the named choices. A targeted, idempotent migration adds these definitions to existing databases without changing annotations.

## Local preview

Requires Node.js 24.4+ in the 24.x series; no third-party JavaScript dependencies or frontend build.

```sh
node manage.mjs import '../Combined data/social_risk_combined_analysis.csv'
node server.mjs --preview
```

Open http://127.0.0.1:4317 and choose Open local workspace, or use `start-preview.command` on the configured Mac. Preview creates a local administrator and is restricted to loopback; production rejects it. Startup backs up and migrates an existing vocabulary. Do not expose preview publicly.

The Drive development database is an independent local workspace, not the Render database. Preserve and migrate its own annotations; never replace it with Render data. Do not run concurrent SQLite writers through Drive/Dropbox synchronization. Server storage must be server-local.

## Deployment and backups

`render.yaml` defines Node 24, runs the test suite as its build, starts `node server.mjs`, and uses `/var/data/coding.sqlite` on a persistent disk. No database, responses, account details, or migration review evidence belong in the repository. Render uses `RENDER_EXTERNAL_URL` as its HTTPS origin; set `APP_ORIGIN` only for a custom origin. The migration runs against that persistent database before the service accepts traffic.

Docker is also supported: set `APP_ORIGIN` in `.env`, place the input CSV under `input/`, then run `docker compose up -d --build` and `docker compose exec coding node manage.mjs import /input/social_risk_combined_analysis.csv`. Publish through an HTTPS reverse proxy to the loopback application port. `Caddyfile.example` is a starting point.

Management commands use `DB_PATH` (default `data/coding.sqlite`):

```sh
node manage.mjs backup /private/new-backup.sqlite
node manage.mjs seed-codebook ADMIN_USERNAME
node manage.mjs add-user USERNAME admin 'Display name' # password from stdin
node manage.mjs reset-password USERNAME               # password from stdin
node manage.mjs disable-user USERNAME
```

Keep passwords out of command arguments and shell history. Production passwords are hashed, sessions expire in 12 hours, cookies are HttpOnly/SameSite, and writes require origin and CSRF checks. There is no public registration or password recovery.

To restore a backup: stop the server, preserve current database/WAL files as a separate rollback copy, restore the snapshot in a clean data directory without stale WAL/SHM files, set service-account ownership, then restart. To roll back a vocabulary deployment, restore the matching prior application code as well, or startup will migrate again.

## Exports and verification

Annotation CSVs contain only saved readings and retain legacy dimensions plus migration flags. Codebook CSVs retain retired codes for audit. Spreadsheet formula-like strings are escaped only in exports; originals remain unchanged in SQLite. History JSON is an audit trail, not a database backup.

```sh
node --test tests/*.test.mjs
```

Tests cover both Drive v4 and expanded Render v5 vocabulary fixtures, canonical definitions, multiple coders and batches, deduplication, ambiguous/unknown labels, independent review flags, preservation, rollback, backup, idempotence, authentication and code API restrictions, original source import, concurrency, comparisons, and exports. Browser verification should cover the flat selector, guide, codebook, current/past batches and administrator migration report. Inspect the live database report after deployment.
