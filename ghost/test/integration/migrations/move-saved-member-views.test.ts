import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const testUtils = require('../../utils');
const db = require('../../../core/server/data/db');

const VERSIONS = path.join(__dirname, '../../../core/server/data/migrations/versions');

function loadMigration(slug: string) {
  const [file] = fs
    .readdirSync(VERSIONS)
    .flatMap((version) =>
      fs
        .readdirSync(path.join(VERSIONS, version))
        .map((name) => path.join(VERSIONS, version, name)),
    )
    .filter((candidate) => candidate.endsWith(`-${slug}.ts`));
  assert.ok(file, `finds the ${slug} migration`);
  return require(file).default;
}

const migration = loadMigration('move-saved-member-views-to-segments');

const run = (step: 'up' | 'down') =>
  db.knex.transaction((transacting: unknown) => migration[step]({ transacting }));

/** A saved member view as Admin wrote one to the setting. */
const memberView = (name: string, filter: string) => ({
  name,
  route: 'members',
  filter: { filter },
});

const postsView = { name: 'Drafts', route: 'posts', filter: { type: 'draft' }, color: 'blue' };

const store = (value: string | null) =>
  db.knex('settings').where({ key: 'shared_views' }).update({ value });

const stored = async (): Promise<string | null> =>
  (await db.knex('settings').where({ key: 'shared_views' }).first('value')).value;

/** The segments table's rows, in the order the segments API lists them. */
const segments = (): Promise<{ id: string; name: string; filter: string }[]> =>
  db
    .knex('segments')
    .select('id', 'name', 'filter')
    .orderBy([{ column: 'sort_order' }, { column: 'created_at' }, { column: 'id' }]);

const segmentNames = async () => (await segments()).map(({ name }) => name);

describe('Migration: move saved member views to segments', function () {
  beforeAll(testUtils.teardownDb);
  beforeAll(testUtils.setup('settings'));

  beforeEach(async function () {
    await db.knex('segments').del();
  });

  it('moves the saved member views into the table, in their order, with the ids they had', async function () {
    await store(
      JSON.stringify([
        memberView('VIP', 'label:vip'),
        postsView,
        memberView('Free', 'status:free'),
        // A second view with a filter had an id of its own.
        memberView('VIP again', 'label:vip'),
      ]),
    );

    await run('up');

    assert.deepEqual(await segments(), [
      { id: '69d782c09ce7e810fbba358d', name: 'VIP', filter: 'label:vip' },
      { id: '9f278cb5780df616c7dd8f29', name: 'Free', filter: 'status:free' },
      { id: '5a90fb032465ae34c410d5d3', name: 'VIP again', filter: 'label:vip' },
    ]);
    assert.equal(await stored(), JSON.stringify([postsView]));
  });

  it('leaves entries that are not segments in the setting', async function () {
    const kept = [
      postsView,
      { name: 'Everyone', route: 'members', filter: {} },
      { name: 'No filter text', route: 'members', filter: { filter: '' } },
      { route: 'members', filter: { filter: 'label:unnamed' } },
      'not a view',
      null,
    ];
    await store(JSON.stringify([...kept, memberView('VIP', 'label:vip')]));

    await run('up');

    assert.deepEqual(await segmentNames(), ['VIP']);
    assert.equal(await stored(), JSON.stringify(kept));
  });

  it('numbers a name the database counts as an earlier view’s', async function () {
    await store(
      JSON.stringify([
        memberView('Cafe', 'label:cafe'),
        memberView('Gold', 'label:gold'),
        memberView('Café', 'label:accent'),
        memberView('Café (2)', 'label:numbered'),
        memberView('CAFÈ', 'label:grave'),
      ]),
    );

    await run('up');

    // A view keeps a name that is its own, so the numbers go around "Café (2)".
    assert.deepEqual(await segmentNames(), ['Cafe', 'Gold', 'Café (3)', 'Café (2)', 'CAFÈ (4)']);
  });

  it('cuts a name to what the table holds, and to make room for a number', async function () {
    await store(
      JSON.stringify([
        memberView('e'.repeat(200), 'label:plain'),
        memberView('é'.repeat(200), 'label:accent'),
      ]),
    );

    await run('up');

    assert.deepEqual(await segmentNames(), ['e'.repeat(191), `${'é'.repeat(187)} (2)`]);
  });

  it('moves nothing when the setting holds no views', async function () {
    for (const value of [null, '', '[]', '{}', 'null', 'not json', '"VIP"']) {
      await store(value);

      await run('up');

      assert.equal(await stored(), value);
      assert.deepEqual(await segments(), []);
    }
  });

  it('changes nothing when it runs again', async function () {
    await store(JSON.stringify([postsView, memberView('VIP', 'label:vip')]));

    await run('up');
    const rows = await segments();
    await run('up');

    assert.deepEqual(await segments(), rows);
    assert.equal(await stored(), JSON.stringify([postsView]));
  });

  it('moves the segments back to the setting when rolled back', async function () {
    const views = [memberView('VIP', 'label:vip'), memberView('Free', 'status:free')];
    await store(JSON.stringify([views[0], postsView, views[1]]));
    await run('up');
    const rows = await segments();

    await run('down');

    assert.deepEqual(await segments(), []);
    assert.equal(await stored(), JSON.stringify([postsView, ...views]));

    await run('up');
    assert.deepEqual(await segments(), rows);
  });
});
