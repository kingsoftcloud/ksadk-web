import { mkdir, writeFile } from 'node:fs/promises';
import { toJSONSchema } from 'zod';
import { groupEventSchema, groupSnapshotSchema, interactionRefSchema, executionSnapshotSchema } from '../dist-lib/teams.js';

// Run after build:lib. Published schema and executable frontend validation share one source.
await mkdir(new URL('../schemas/', import.meta.url), { recursive: true });
for (const [name, schema] of [['group-snapshot', groupSnapshotSchema], ['group-event', groupEventSchema], ['interaction-ref', interactionRefSchema], ['execution-snapshot', executionSnapshotSchema]]) {
  const output = { ...toJSONSchema(schema), $id: `https://ksadk.io/schemas/teams/v1/${name}.json`, title: `teams.ksadk.io/v1 ${name}` };
  await writeFile(new URL(`../schemas/teams-v1-${name}.schema.json`, import.meta.url), `${JSON.stringify(output, null, 2)}\n`);
}
