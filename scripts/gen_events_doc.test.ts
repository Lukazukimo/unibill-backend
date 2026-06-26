// Tests for scripts/gen_events_doc.ts — emitted-event extraction + §F BR parse.
// Ref: T-624 (#134), spec §F.

import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { parseBusinessRules, parseEmittedEventTypes, renderEventsBody } from './gen_events_doc.ts';

Deno.test('parseEmittedEventTypes finds dotted type literals + dedups across files, sorted', () => {
  const files = [
    {
      path: 'a/index.ts',
      text: `await emitEvent({ type: 'invoice.extracted', aggregate_type: 'invoice' });`,
    },
    {
      path: 'b/index.ts',
      text:
        `emitDomainEvent({\n  type: 'household.created',\n});\nfoo({ type: 'invoice.extracted' });`,
    },
    { path: 'c/index.ts', text: `const x = { kind: 'not.an.event' };` }, // not a `type:` field
  ];
  const events = parseEmittedEventTypes(files);
  assertEquals(events.map((e) => e.type), ['household.created', 'invoice.extracted']);
  const inv = events.find((e) => e.type === 'invoice.extracted')!;
  assertEquals(inv.files.sort(), ['a/index.ts', 'b/index.ts']);
});

Deno.test('parseEmittedEventTypes ignores non-dotted type values', () => {
  const events = parseEmittedEventTypes([{ path: 'x.ts', text: `type: 'user'` }]);
  assertEquals(events.length, 0);
});

const SPEC_F = `
### F. Business rules catalog

| ID | Domínio | Trigger | Condição | Efeito | Configs | Eventos |
|---|---|---|---|---|---|---|
| BR-001 | Extraction | Após Layer 4 | \`confidence_final >= 0.85\` | \`status='extracted'\` | \`extraction.confidence_threshold\` | \`invoice.extracted\` |
| BR-004 | Extraction | AI chain falha | OPEN state | needs_review | \`ai.chain.*\` | \`invoice.routed_to_review\` |

### G. Something else
| not | a | br | row |
`;

Deno.test('parseBusinessRules extracts BR rows from spec §F only', () => {
  const rules = parseBusinessRules(SPEC_F);
  assertEquals(rules.length, 2);
  assertEquals(rules[0].id, 'BR-001');
  assertEquals(rules[0].domain, 'Extraction');
  assert(rules[0].events.includes('invoice.extracted'));
  assertEquals(rules[1].id, 'BR-004');
});

Deno.test('renderEventsBody renders both the emitted list and the BR table', () => {
  const md = renderEventsBody(
    [{ type: 'invoice.extracted', files: ['a/index.ts'] }],
    parseBusinessRules(SPEC_F),
  );
  assert(md.includes('invoice.extracted'));
  assert(md.includes('BR-001'));
  assert(md.includes('## ')); // has section headings
});
