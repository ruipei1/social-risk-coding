# Social Risk Coding Workspace

## Current vocabulary: behavior-flat-v8

Behavior starts with a single, flat list of 20 labels; coders can add shared draft behavior codes. Other behavior appears last in the selector. Exact names, definitions, inclusion rules, exclusion rules, and examples live in `behavior-vocabulary.mjs`; this is the authoritative versioned vocabulary. The reading selector, guide, codebook and administrator comparison editor show no higher-level behavior categories. Existing behavior names and definitions are protected through the code API and UI. New behavior codes have no higher-level category, and existing or retired names cannot be reintroduced. Use Other behavior with a short observation for a clearly described action outside the vocabulary. Consequences, people, settings, response type, and researcher-added nonbehavior labels remain unchanged and editable.

Code actions completed, considered, attempted, or avoided independently of the survey's Approach/Avoid prompt. Nonparticipation is not automatically a refusal. Online communication and AI are media, not behavior categories: code their stated function. Public online posting is Performing or posting publicly (online or in person) when audience exposure is central; add a content label when the post also expresses an opinion or includes personal disclosure. Drawing attention to oneself or being put on the spot captures attention exposure without active public participation. Multiple labels may represent distinct actions or distinct behavioral functions of one act.

## Behavior migration and review

`behavior-migration.mjs` inventories **every actual behavior record**, including edited, researcher-added and retired records. `seedStarterCodebook` invokes the v8 migration, never the earlier consolidation routines. A legacy vocabulary receives the full flat-vocabulary migration; an existing v7 database receives a targeted v8 update that renames the existing intervention code in place, adds the attention code, updates guidance, and preserves researcher-added behavior codes and every annotation. Startup applies v8 before listening for requests. It is transactional and records the version only after success; rerunning an applied version leaves codebook, annotations and history unchanged.

Before mutating a disk database the migration uses SQLite `VACUUM INTO` to create a consistent snapshot beside it, including committed WAL contents. The filename is unique, contains the target vocabulary version, and has owner-only permissions. Backup failure aborts startup. This snapshot includes research data and account/session records: keep it private, copy it securely off-server, and never commit it to GitHub. The in-memory test database has no backup file.

Superseded choices are retired; their IDs, names, definitions, and category metadata are retained. An existing record with an exact canonical name is reused, with its full previous definition and category saved to `code_before_flat_migration` history before adopting the canonical definition. All coder/batch selections are remapped and deduplicated. Each affected annotation gains a version and a history entry containing previous payload, new payload, mapping decisions, coder, batch and unchanged status. Original response text, all nonbehavior coding, notes, evidence, response type, coder/batch ownership, and completion/discussion statuses are preserved. Before/after hashes in the migration manifest verify preservation of responses, stable annotation content, nonbehavior code records, and preexisting history.

Context-sensitive and unknown/edited labels are **not guessed from keywords**. For instance, Sharing opinions may contain a public performance inherited from an earlier merge; Asking for contact information need not be romantic. Those assignments retain the retired code and get a separate `behavior_reviews` record carrying original response, previous annotation and relevant earlier history. Other to discuss becomes a migration review flag, never an automatic Other behavior assignment. Retained legacy selections cannot be newly added to another reading.

Administrators open **Team → Vocabulary migration report and review assignments** (`/migration-review`). The report includes backup path, preservation hashes, complete old-to-new mapping, exact canonical definitions, and every unresolved assignment. An administrator can resolve a review using the original response and history, choose zero or more canonical replacements, and record the evidence. Resolution is version-checked and transactional, preserves notes/status, and writes `annotation_migration_review` history. It may reconcile a past batch without opening that batch for ordinary edits. Unresolved flags remain visible in the reading room and annotation CSV export, independently of completion status. A normal coding edit does not silently clear migration flags.

`GET /api/codebook-version` requires sign-in and returns the version plus exact selectable names/definitions. `GET /api/behavior-migration` and its resolution endpoint require an administrator. `/health` returns application vocabulary version and Render commit metadata without research data. Verify actual live labels and the migration report, not `/health` alone.

## Weekly coding workflow

The current workflow assigns one responsible RA to each eligible response. Joyce, Liqing, and Melissa receive 150 new, nonoverlapping responses in each active Monday–Sunday week unless fewer remain. Releases are created deterministically and idempotently on the server the first time the server evaluates that week; refreshing or signing in again cannot change them. Thanksgiving, winter, and spring breaks are seeded in `weekly_breaks` and editable in **Project overview**. Pausing prevents new releases without hiding or changing existing work.

The **My Coding** dashboard separates the current week from earlier weeks, shows carryover explicitly, and resumes the next unfinished response. Unfinished work remains assigned to its original RA indefinitely. Completed work stays reviewable. Draft selections autosave but count as complete only after **Save & Next**. Weekly API access limits each RA to their own assignments; administrators use the overview and history tools rather than writing through an RA queue.

Weekly activation is deliberately separate from schema deployment. **Project overview → Review migration plan** lists candidate batches and exact counts. The administrator selects the batch whose completed readings remain current. Activation uses `VACUUM INTO` to back up a disk database, preserves all old batches and annotations, creates a new weekly coding batch, and records an idempotent migration ledger/history entry. It never runs automatically during deployment. See [the weekly migration runbook](docs/WEEKLY_CODING_MIGRATION.md).

## Historical reading and team workflow

The imported dataset has 658 survey records / 5,264 response slots, including 5,075 nonblank responses. Responses are immutable. Filters separate domain, perspective, prompt and reading status. Coders have independent annotations within each batch; shared codebook access does not permit retrieving another coder's readings. Notes autosave; Complete & next advances the queue. Network/conflict failures retain unsaved text in the page: do not close it before recovering your work. This is not an offline app.

Historical coding batches remain selectable in read-only mode. Their annotations and coder/batch identifiers stay exportable, and the shared codebook is unchanged. The previous bulk-batch creation UI is superseded by weekly scheduling.

Compare coders is administrator-only and assesses completed, overlapping historical readings for the 80% calibration threshold. A coder pair agrees when at least one behavior label overlaps; two empty sets, or an empty set paired with Other behavior or an ambiguous response, are also accepted. For three or more completed readings, every coder pair must satisfy the rule for the response to count as agreement. Consequence, who, setting, response type, and observations remain visible for discussion but do not otherwise affect agreement badges, filters, summaries, or pass/fail status. Missing or unfinished readings are not disagreements. New weekly work intentionally has no overlap.

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

Tests cover vocabulary migrations plus exact weekly quotas, no cross-RA overlap, calendar boundaries, breaks, carryover, future quota changes, migration rerun safety, assignment privacy, optimistic concurrency, and current/historical exports. Browser verification should cover the RA dashboard, resume flow, tablet layout, project overview, schedule editing, and migration preview. Inspect the live preview before approving production activation.
