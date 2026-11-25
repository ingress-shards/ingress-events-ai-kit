---
name: weekend-data-update
description: >-
  Use after an event weekend to ingest new raw observation data and validate
  generated season data in ingress-shards.github.io.
---

# Weekend Data Update (`ingress-shards.github.io`)

## 1. Place Source Files
- Add raw observation files under `ingress-shards.github.io/data/<seasonId>/`, matching a valid `seasonId` in `season_manifest.json` (leave filename parsing to `DataIngestionPipeline`).
- **Never** hand-edit generated files under `gen/data/`.

## 2. Process & Verify Site Counts
1. Run the data preparation pipeline:
   ```bash
   npm --prefix ingress-shards.github.io run prepare:data
   ```
   *(If fingerprint caching skips regeneration unexpectedly, run `tsx scripts/process-season-data.ts --force` inside `ingress-shards.github.io`.)*
2. Inspect the console summary and confirm `<seasonId>` reports the expected updated site count (not `0 sites`).

## 3. Validate & Commit Prep
1. Run full local validation:
   ```bash
   npm --prefix ingress-shards.github.io run validate
   ```
2. Optionally run `npm --prefix ingress-shards.github.io start` to spot-check the map UI locally, then use `prepare-commits` when ready to commit.
