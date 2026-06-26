// Tests for scripts/gen_configuration_doc.ts — the seed parser + renderer.
// Ref: T-624 (#134), spec §B.

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { parseSeedRows, renderConfigBody } from './gen_configuration_doc.ts';

const SAMPLE = `
INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('features.extraction_enabled', 'global', NULL, jsonb_build_object('v', true), 'features',
        'Master switch do extraction-worker.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value;

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('retention.consent_log.max_age_days', 'global', NULL, jsonb_build_object('v', 1825), 'retention',
        '5 anos (limite prudente). LGPD.', false)
ON CONFLICT (key) WHERE scope = 'global' DO UPDATE
  SET value = EXCLUDED.value;

INSERT INTO public.app_settings (key, scope, scope_id, value, category, description, requires_restart)
VALUES ('ai.gemini.api_key_secret_id', 'global', NULL, jsonb_build_object('v', '00000000-0000-0000-0000-000000000000'), 'ai',
        'Vault secret id (placeholder).', false)
ON CONFLICT (key) DO NOTHING;
`;

Deno.test('parseSeedRows extracts key/value/category/description for every INSERT', () => {
  const rows = parseSeedRows(SAMPLE);
  assertEquals(rows.length, 3);
  assertEquals(rows[0], {
    key: 'features.extraction_enabled',
    category: 'features',
    value: 'true',
    description: 'Master switch do extraction-worker.',
  });
  assertEquals(rows[1].key, 'retention.consent_log.max_age_days');
  assertEquals(rows[1].value, '1825');
  assertEquals(rows[1].category, 'retention');
  assertEquals(rows[1].description, '5 anos (limite prudente). LGPD.');
});

Deno.test('parseSeedRows keeps the uuid placeholder value verbatim', () => {
  const rows = parseSeedRows(SAMPLE);
  assertEquals(rows[2].value, '00000000-0000-0000-0000-000000000000');
  assertEquals(rows[2].category, 'ai');
});

Deno.test('renderConfigBody groups by category and lists every key', () => {
  const md = renderConfigBody(parseSeedRows(SAMPLE));
  // category headings present
  assert(md.includes('### `ai`'));
  assert(md.includes('### `features`'));
  assert(md.includes('### `retention`'));
  // a key row present with its value + description
  assert(md.includes('`features.extraction_enabled`'));
  assert(md.includes('Master switch do extraction-worker.'));
  // deterministic: categories alphabetical → ai before features before retention
  assert(md.indexOf('### `ai`') < md.indexOf('### `features`'));
  assert(md.indexOf('### `features`') < md.indexOf('### `retention`'));
});

Deno.test('renderConfigBody is idempotent (stable output)', () => {
  const rows = parseSeedRows(SAMPLE);
  assertEquals(renderConfigBody(rows), renderConfigBody(rows));
});
