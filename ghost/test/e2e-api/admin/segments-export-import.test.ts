import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';

const { agentProvider, fixtureManager } = require('../../utils/e2e-framework');

type Segment = { id: string; name: string; filter: string };
type Setting = { key: string; value: unknown };
type ExportData = { segments?: unknown[]; settings: Setting[] };
type Export = { db: [{ meta: { version: string }; data: ExportData }] };

type ApiRequest = Promise<{ body: { segments: Segment[]; settings: Setting[] } & Export }> & {
  body(payload: object): ApiRequest;
  attach(field: string, file: string): ApiRequest;
  expectStatus(status: number): ApiRequest;
};

type AdminAgent = {
  get(url: string): ApiRequest;
  post(url: string): ApiRequest;
  put(url: string): ApiRequest;
  delete(url: string): ApiRequest;
  loginAsOwner(): Promise<void>;
};

/** A saved member view as an older version of Ghost stored one in the `shared_views` setting. */
const memberView = (name: string, filter: string) => ({
  name,
  route: 'members',
  filter: { filter },
});

const postsView = { name: 'Drafts', route: 'posts', filter: { type: 'draft' }, color: 'blue' };

// Saved member views are segments. A site export carries them, and an import adds them to the
// site, whether the file holds them as segments or, as older versions exported them, as entries
// of the `shared_views` setting.
describe('Segments in a site export and import', function () {
  let agent: AdminAgent;
  let directory: string;

  async function browse() {
    const { body } = await agent.get('segments/').expectStatus(200);
    return body.segments;
  }

  const names = async () => (await browse()).map(({ name }) => name);

  async function add(name: string, filter: string) {
    await agent
      .post('segments/')
      .body({ segments: [{ name, filter }] })
      .expectStatus(201);
  }

  async function removeSegments() {
    for (const { id } of await browse()) {
      await agent.delete(`segments/${id}/`).expectStatus(204);
    }
  }

  async function saveSharedViews(value: string) {
    await agent
      .put('settings/')
      .body({ settings: [{ key: 'shared_views', value }] })
      .expectStatus(200);
  }

  /** The views of the posts list, which stay in the `shared_views` setting. */
  async function postsViews() {
    const { body } = await agent.get('settings/').expectStatus(200);
    const value = body.settings.find(({ key }) => key === 'shared_views')?.value;
    const views: { route: string }[] = JSON.parse(typeof value === 'string' ? value : '[]');
    return views.filter(({ route }) => route === 'posts');
  }

  /** What a site export holds of the site's saved views: its segments and the setting. */
  async function exportSavedViews(): Promise<ExportData> {
    const { body } = await agent.get('db/').expectStatus(200);
    const { segments, settings } = body.db[0].data;
    return { segments, settings: settings.filter(({ key }) => key === 'shared_views') };
  }

  async function importData(data: ExportData) {
    const file = path.join(directory, 'export.json');
    await fs.writeFile(file, JSON.stringify({ db: [{ meta: { version: '6.0.0' }, data }] }));
    await agent.post('db/').attach('importfile', file).expectStatus(200);
  }

  beforeAll(async function () {
    agent = await agentProvider.getAdminAPIAgent();
    await fixtureManager.init();
    await agent.loginAsOwner();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'segments-import-e2e-'));
  });

  afterAll(async function () {
    await fs.remove(directory);
  });

  afterEach(async function () {
    await removeSegments();
    await saveSharedViews('[]');
  });

  it('brings the segments of an exported site back, in their order', async function () {
    await saveSharedViews(JSON.stringify([postsView]));
    // Added in the opposite order to the one their ids sort in.
    await add('Free', 'status:free');
    await add('VIP', 'label:vip');
    const exported = await exportSavedViews();
    const segments = await browse();
    await removeSegments();

    await importData(exported);

    assert.deepEqual(await browse(), segments);
    assert.deepEqual(await postsViews(), [postsView]);
  });

  it('imports the saved member views of an export from an older version', async function () {
    const views = [memberView('VIP', 'label:vip'), postsView, memberView('Free', 'status:free')];

    await importData({ settings: [{ key: 'shared_views', value: JSON.stringify(views) }] });

    assert.deepEqual(
      (await browse()).map(({ name, filter }) => ({ name, filter })),
      [
        { name: 'VIP', filter: 'label:vip' },
        { name: 'Free', filter: 'status:free' },
      ],
    );
    assert.deepEqual(await postsViews(), [postsView]);
  });

  it('numbers a segment whose name the site has for another filter', async function () {
    await add('VIP', 'label:vip');
    const views = [
      // The site has this segment already.
      memberView('VIP', 'label:vip'),
      memberView('VIP', 'label:gold'),
      memberView('vip', 'label:silver'),
    ];

    await importData({ settings: [{ key: 'shared_views', value: JSON.stringify(views) }] });

    assert.deepEqual(
      (await browse()).map(({ name, filter }) => ({ name, filter })),
      [
        { name: 'VIP', filter: 'label:vip' },
        { name: 'VIP (2)', filter: 'label:gold' },
        { name: 'vip (3)', filter: 'label:silver' },
      ],
    );
  });

  it('keeps a name that is a segment’s own, and numbers around it', async function () {
    const views = [
      memberView('Gold', 'label:gold'),
      memberView('gold', 'label:silver'),
      memberView('gold (2)', 'label:bronze'),
      // The file has this filter twice.
      memberView('Golden', 'label:gold'),
    ];

    await importData({ settings: [{ key: 'shared_views', value: JSON.stringify(views) }] });

    assert.deepEqual(await names(), ['Gold', 'gold (3)', 'gold (2)']);
  });

  it('cuts a name that is too long and leaves out a view that cannot be a segment', async function () {
    const views = [
      memberView('n'.repeat(200), 'label:long'),
      memberView('   ', 'label:unnamed'),
      { name: 'Everyone', route: 'members', filter: {} },
    ];

    await importData({ settings: [{ key: 'shared_views', value: JSON.stringify(views) }] });

    assert.deepEqual(await names(), ['n'.repeat(191)]);
  });
});
