// Tests for scripts/gen_dbml.ts — the migrations → DBML parser (#266 part a).
// The generator statically parses supabase/migrations/*.sql (no live DB needed)
// into tables, columns, enums and intra-`public` foreign-key Refs.

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { parseEnums, parseTables, renderDbml, splitTopLevel } from './gen_dbml.ts';

Deno.test('splitTopLevel respects parentheses', () => {
  assertEquals(splitTopLevel('a int, b numeric(5, 2), c text'), [
    'a int',
    'b numeric(5, 2)',
    'c text',
  ]);
});

Deno.test('parseEnums extracts CREATE TYPE ... AS ENUM', () => {
  const sql = `CREATE TYPE public.capacity_status AS ENUM ('green', 'orange', 'red');`;
  assertEquals(parseEnums(sql), [
    { name: 'public.capacity_status', values: ['green', 'orange', 'red'] },
  ]);
});

Deno.test('parseTables extracts columns, pk and intra-public refs; skips auth.* refs', () => {
  const sql = `
CREATE TABLE IF NOT EXISTS public.household_members (
  id            uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES public.households(id),
  user_id       uuid NOT NULL REFERENCES auth.users(id), -- AUDIT-FK-OK
  role          public.member_role NOT NULL DEFAULT 'member',
  score         numeric(5, 2),
  created_at    timestamptz NOT NULL DEFAULT now()
);`;
  const tables = parseTables(sql);
  assertEquals(tables.length, 1);
  const t = tables[0];
  assertEquals(t.name, 'public.household_members');
  assertEquals(t.columns.map((c) => c.name), [
    'id',
    'household_id',
    'user_id',
    'role',
    'score',
    'created_at',
  ]);
  // pk flagged
  assertEquals(t.columns.find((c) => c.name === 'id')?.pk, true);
  // types preserved (incl. qualified enum + numeric precision)
  assertEquals(t.columns.find((c) => c.name === 'role')?.type, 'public.member_role');
  assertEquals(t.columns.find((c) => c.name === 'score')?.type, 'numeric(5, 2)');
  // intra-public ref kept, auth.* ref skipped
  assertEquals(t.refs, [{ col: 'household_id', toTable: 'public.households', toCol: 'id' }]);
});

Deno.test('parseTables reads a table-level FOREIGN KEY constraint', () => {
  const sql = `
CREATE TABLE public.invoice_lines (
  id          uuid PRIMARY KEY,
  invoice_id  uuid NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES public.invoices(id)
);`;
  const t = parseTables(sql)[0];
  assertEquals(t.refs, [{ col: 'invoice_id', toTable: 'public.invoices', toCol: 'id' }]);
  // the constraint line is not a column
  assert(!t.columns.some((c) => c.name.toUpperCase() === 'FOREIGN'));
});

Deno.test('renderDbml emits Table, Enum and Ref blocks (valid DBML shape)', () => {
  const enums = [{ name: 'public.member_role', values: ['admin', 'member'] }];
  const tables = [{
    name: 'public.households',
    columns: [{ name: 'id', type: 'uuid', pk: true }],
    refs: [],
  }, {
    name: 'public.household_members',
    columns: [
      { name: 'id', type: 'uuid', pk: true },
      { name: 'household_id', type: 'uuid', pk: false },
    ],
    refs: [{ col: 'household_id', toTable: 'public.households', toCol: 'id' }],
  }];
  const out = renderDbml(enums, tables);
  assert(out.includes('Table "public"."households"'));
  assert(out.includes('"id" uuid [pk]'));
  assert(out.includes('Enum "public"."member_role"'));
  assert(
    out.includes('Ref: "public"."household_members"."household_id" > "public"."households"."id"'),
  );
});
