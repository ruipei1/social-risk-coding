# Weekly coding migration runbook

## What deployment changes

Deploying the code adds empty schedule, break, week, assignment, and migration-ledger tables. It does not create weekly assignments, change the active coding batch, or alter an annotation. Existing responses, codebook entries, users, sessions, batches, annotations, timestamps, migration reviews, and revision history remain intact.

The initial calendar is:

- Active: November 16–22, 2026
- Thanksgiving break: November 23–29, 2026
- Active: November 30–December 6, 2026
- Winter break: December 7, 2026–January 10, 2027
- Active Mondays from January 11, 2027 onward
- Spring break: March 13–20, 2027

All date decisions use `America/New_York`. A break suppresses any Monday–Sunday coding week it overlaps.

## Required administrator decision

Open **Project overview → Review migration plan**. The preview groups annotations by the reliable `coding_batches.id`/batch metadata and shows:

- all nonblank responses;
- completed responses in the selected preservation batch;
- other or incomplete coded responses that require recoding;
- never-coded responses;
- total remaining and workload by RA.

Production needs explicit confirmation because “Fresh coding Nov 11 2026” is the newest batch but currently has no completed readings, while “Oct 30” is the newest batch containing completed work. Select the batch whose completed readings should remain valid. Do not use timestamps as a substitute for this decision.

## Activation safeguards

When the administrator confirms the current preview:

1. The server creates a consistent SQLite backup with `VACUUM INTO` under the database directory's private `backups/` folder.
2. The selected batch's completed response IDs become exempt from reassignment.
3. All older/incomplete and never-coded nonblank responses become eligible exactly once.
4. A new weekly annotation batch is created; all historical batches remain read-only.
5. A `weekly_migrations` row and `weekly_migration` history entry record the source batch, backup path, counts, and preview hash.

The preview hash makes activation repeatable: submitting the same approved migration twice returns the existing result instead of creating another round.

## Weekly release behavior

The server evaluates the current New York calendar week at startup/login/dashboard access. The unique `coding_weeks.week_start` key makes release at most once. Eligible responses are deterministically ordered and assigned without replacement. Each active RA receives 150 new items while at least 450 remain; the final week is divided as evenly as possible.

Changing the quota affects only future weeks. Pausing stops future releases. Removing a break is allowed until it has affected the released calendar audit; released break weeks remain immutable. Unfinished assignments are never reassigned automatically.

## Validation before production approval

Run:

```sh
npm test
```

Then verify in a staging copy:

1. Migration preview counts reconcile to the nonblank response total.
2. The selected exemption batch is correct.
3. A backup file exists and opens with `PRAGMA integrity_check` returning `ok`.
4. Joyce, Liqing, and Melissa each receive 150 distinct responses in an active full week.
5. No response occurs under more than one current responsible RA.
6. A saved draft resumes and does not increment completion.
7. Carryover remains visible after a later week is released.
8. Current and historical CSV exports open and contain stable response IDs.

Production activation remains an explicit administrator action; deployment alone is safe.
