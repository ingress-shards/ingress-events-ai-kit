---
name: season-setup
description: >-
  Use at the start of a new Ingress season to assess code/schema impact and
  update season_manifest.json and event_blueprints.json in ingress-events-core.
---

# Season Setup (`ingress-events-core`)

## 1. Schema & Code Impact Assessment (Required First)
Before editing any JSON config, inspect the new season's announcement/rules against:
- `ingress-events-core/conf/event_blueprints.json`
- `ingress-events-core/src/types/config/`
- `ingress-events-core/src/pipeline/`
- `ingress-events-core/scripts/geocode.py`

Explicitly tell the user whether **code, type, scoring, ornament asset, or geocoder changes** are required (for example: a new `eventType`, new `shardMechanics` or `linkRules`, new ornament icon assets, or a new marker format on `overviewUrl`) before making edits.

## 2. Edit Source Configs Only
- Update `ingress-events-core/conf/season_manifest.json` (`id`, `name`, `year`, `overviewUrl`, `events[]` with `startTime` and `mechanics`, and optional `schedule` overrides if `overviewUrl` lacks markers).
- Update `ingress-events-core/conf/event_blueprints.json` if new reusable blueprints, ornaments, or mechanics were added.
- **Never** hand-edit generated files under `gen/` or `dist/`.

## 3. Generate, Validate & Sync
1. Generate Zod schemas and geocoded manifests:
   ```bash
   yarn --cwd ingress-events-core generate
   ```
   *(Pass `--force` to `scripts/geocode.py` if re-scraping an unchanged manifest.)*
2. Run full validation (which also runs `yarn build` and `scripts/sync-to-siblings.js` into local sibling `node_modules`):
   ```bash
   yarn --cwd ingress-events-core validate
   ```
3. Follow the `cross-repo-release` skill to publish `@ingress-shards/ingress-events-core` and update consumers.
