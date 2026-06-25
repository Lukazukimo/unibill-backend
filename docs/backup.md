# Backup & retention (Backblaze B2)

Disaster-recovery backups for the Unibill backend. Spec §11.3. Restore procedure
lives in [RUNBOOK.md §1](RUNBOOK.md) (DR) and §8 (6-monthly test restore).

## What runs

| Workflow | Schedule | Produces |
|---|---|---|
| [`backup-weekly.yml`](../.github/workflows/backup-weekly.yml) | Sun 05:00 UTC | `pg_dump --format=custom` → `s3://$B2_BUCKET/unibill-YYYYMMDD.dump`; the first run each month is also copied to `monthly/unibill-YYYYMM.dump` |
| [`backup-storage-metadata.yml`](../.github/workflows/backup-storage-metadata.yml) | 1st 05:00 UTC | NDJSON index of invoice-PDF `{path, bucket, sha256}` → `s3://$B2_BUCKET/archives/storage_metadata/YYYY-MM.ndjson.gz` |

Both can be run on demand via **workflow_dispatch**, and stay inert until
`SUPABASE_DB_URL` + `B2_BUCKET` are configured (see [secrets.md](secrets.md)).
Free-tier B2 (10 GB) covers Unibill for 5+ years.

## One-time bucket setup

Create a **private** bucket and an application key scoped to it:

```bash
b2 account authorize "$B2_KEY_ID" "$B2_APPLICATION_KEY"
b2 bucket create unibill-backups allPrivate
```

### Retention lifecycle policy (4 weekly + 6 monthly)

B2 lifecycle rules are age-based per file-name prefix. Two rules approximate the
target: weekly dumps (root `unibill-` prefix) are kept ~5 weeks; monthly
promotions (`monthly/` prefix) are kept ~6 months.

```json
[
  {
    "fileNamePrefix": "unibill-",
    "daysFromUploadingToHiding": 35,
    "daysFromHidingToDeleting": 1
  },
  {
    "fileNamePrefix": "monthly/",
    "daysFromUploadingToHiding": 190,
    "daysFromHidingToDeleting": 1
  },
  {
    "fileNamePrefix": "archives/storage_metadata/",
    "daysFromUploadingToHiding": 400,
    "daysFromHidingToDeleting": 1
  }
]
```

Apply it once with the b2 CLI (lifecycle rules replace, so include every rule):

```bash
b2 bucket update unibill-backups allPrivate \
  --lifecycleRule '{"fileNamePrefix":"unibill-","daysFromUploadingToHiding":35,"daysFromHidingToDeleting":1}' \
  --lifecycleRule '{"fileNamePrefix":"monthly/","daysFromUploadingToHiding":190,"daysFromHidingToDeleting":1}' \
  --lifecycleRule '{"fileNamePrefix":"archives/storage_metadata/","daysFromUploadingToHiding":400,"daysFromHidingToDeleting":1}'
```

> Older b2 CLI: the subcommand is `b2 update-bucket` and the flag `--lifecycleRules` (a JSON array). Verify with `b2 bucket get unibill-backups`.

## Restore

See [RUNBOOK.md §1](RUNBOOK.md):
`pg_restore --no-owner --no-acl --clean --if-exists -d "$PGURL" ./unibill-YYYYMMDD.dump`
plus the post-restore smoke queries. The 6-monthly **test restore** drill is
RUNBOOK §8 (and task T-622). PDF-content restore is roadmap; the storage-metadata
NDJSON is the recoverable index of which PDFs existed and their sha256.
