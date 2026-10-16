import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_CITIES } from '../server/providers/cities.js';
import { createProviders } from '../server/providers/index.js';
import { createKopisProvider } from '../server/providers/kopis.js';
import { createCultureProvider } from '../server/providers/culture.js';
import { inferPriceType } from '../server/providers/classify.js';
import { stripHtml } from '../server/providers/text.js';
import { ProviderError } from '../server/providers/errors.js';
import type { FetchFn } from '../server/providers/fetch.js';

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
const gangneung = DEFAULT_CITIES.find((c) => c.id === 'gangneung')!;
const andong = DEFAULT_CITIES.find((c) => c.id === 'andong')!;

function mockFetch(map: Record<string, string>): FetchFn {
  return async (url: string) => {
    const parsed = new URL(url);
    const kopisKey = parsed.searchParams.get('signgucodesub');
    const cultureKey = parsed.pathname.includes('area2') ? 'area2' : parsed.pathname.includes('detail2') ? 'detail2' : '';
    const lookup = kopisKey ? `signgucodesub=${kopisKey}` : cultureKey;
    const body =
      map[lookup] ??
      Object.entries(map).find(([key]) => key !== 'default' && url.includes(key))?.[1] ??
      map.default;
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
  };
}

describe('DEFAULT_CITIES', () => {
  it('includes seven official KOPIS region codes', () => {
    assert.equal(DEFAULT_CITIES.length, 7);
    const andongCity = DEFAULT_CITIES.find((c) => c.id === 'andong');
    assert.deepEqual(andongCity?.kopisSido, '47');
    assert.deepEqual(andongCity?.kopisSigungu, '4717');
  });
});

describe('createProviders', () => {
  it('omits providers without keys', () => {
    const providers = createProviders({ kopis: '', culture: '   ' });
    assert.deepEqual(providers, {});
  });
  it('includes configured providers only', () => {
    const providers = createProviders({ kopis: 'k1', culture: 'c1' });
    assert.ok(providers.kopis);
    assert.ok(providers.culture);
  });
});

describe('KOPIS adapter', { concurrency: 1 }, () => {
  it('parses empty and multi list responses', async () => {
    const fetch = mockFetch({
      'signgucodesub=5115': fixture('kopis-list-empty.xml'),
      'signgucodesub=4717': fixture('kopis-list-multi.xml'),
    });
    const provider = createKopisProvider('PLAIN_KEY', { fetch });
    const empty = await provider.list({ city: gangneung, from: '2026-05-01', to: '2026-05-31', page: 1, pageSize: 100 });
    assert.equal(empty.items.length, 0);
    assert.equal(empty.hasMore, false);

    const list = await provider.list({ city: andong, from: '2026-05-01', to: '2026-05-10', page: 1, pageSize: 100 });
    assert.equal(list.items.length, 2);
    assert.equal(list.items[0].classification, 'performance');
    assert.equal(list.items[0].startDate, '2026-05-01');
    assert.equal(list.items[1].classification, 'review');
    assert.match(list.items[1].reviewReason, /다름/);
  });

  it('maps auth faults to kind auth without leaking key', async () => {
    const secret = 'SECRET_KOPIS_KEY';
    const fetch = mockFetch({ 'signgucodesub=4717': fixture('kopis-auth-error.xml') });
    const provider = createKopisProvider(secret, { fetch });
    await assert.rejects(
      () => provider.list({ city: andong, from: '2026-05-01', to: '2026-05-10', page: 1, pageSize: 10 }),
      (error: unknown) => {
        assert.equal((error as ProviderError).kind, 'auth');
        assert.equal(String(error).includes(secret), false);
        return true;
      },
    );
  });

  it('rejects windows longer than 31 days', async () => {
    const provider = createKopisProvider('k', { fetch: async () => new Response('<dbs/>') });
    await assert.rejects(
      () => provider.list({ city: andong, from: '2026-01-01', to: '2026-03-01', page: 1, pageSize: 10 }),
      (error: unknown) => {
        assert.equal((error as ProviderError).kind, 'schema');
        return true;
      },
    );
  });

  it('does not place API key in raw payload', async () => {
    const secret = 'RAW_HIDE_KEY';
    const fetch = mockFetch({ 'signgucodesub=4717': fixture('kopis-list-multi.xml') });
    const provider = createKopisProvider(secret, { fetch });
    const list = await provider.list({ city: andong, from: '2026-05-01', to: '2026-05-10', page: 1, pageSize: 100 });
    assert.equal(JSON.stringify(list.items[0].raw).includes(secret), false);
  });
});

describe('Culture adapter', { concurrency: 1 }, () => {
  it('paginates and normalizes list rows', async () => {
    const fetch = mockFetch({ area2: fixture('culture-area-page.xml') });
    const provider = createCultureProvider('CULTURE_KEY', { fetch });
    const list = await provider.list({ city: gangneung, from: '2026-06-01', to: '2026-06-30', page: 1, pageSize: 1 });
    assert.equal(list.items.length, 1);
    assert.equal(list.hasMore, true);
    assert.equal(list.items[0].genre, '음악');
    assert.equal(list.items[0].priceType, 'unknown');
    assert.equal(list.items[0].detailState, 'pending');
  });

  it('excludes exhibitions even when serviceTp is A', async () => {
    const fetch = mockFetch({ area2: fixture('culture-exhibition.xml') });
    const provider = createCultureProvider('CULTURE_KEY', { fetch });
    const list = await provider.list({ city: gangneung, from: '2026-06-01', to: '2026-06-30', page: 1, pageSize: 10 });
    assert.equal(list.items[0].classification, 'excluded');
  });

  it('maps auth header codes', async () => {
    const fetch = mockFetch({ area2: fixture('culture-auth.xml') });
    const provider = createCultureProvider('BAD_KEY', { fetch });
    await assert.rejects(
      () => provider.list({ city: gangneung, from: '2026-06-01', to: '2026-06-02', page: 1, pageSize: 10 }),
      (error: unknown) => {
        assert.equal((error as ProviderError).kind, 'auth');
        return true;
      },
    );
  });

  it('avoids double-encoding pre-encoded service keys in URL', async () => {
    let seen = '';
    const encoded = 'abc%2Bdef%3D';
    const fetch: FetchFn = async (url) => {
      seen = url;
      return new Response(fixture('culture-area-page.xml'), { status: 200 });
    };
    const provider = createCultureProvider(encoded, { fetch });
    await provider.list({ city: gangneung, from: '2026-06-01', to: '2026-06-02', page: 1, pageSize: 10 });
    assert.match(seen, /serviceKey=abc%2Bdef%3D/);
    assert.equal(seen.includes('%252B'), false);
  });
});

describe('text helpers', () => {
  it('strips external HTML', () => {
    assert.equal(stripHtml('<p>안녕<br/>하세요</p>'), '안녕 하세요');
  });
});

describe('price inference', () => {
  it('does not treat paid amounts as free', () => {
    assert.equal(inferPriceType('전석 50,000원'), 'paid');
    assert.equal(inferPriceType('0원'), 'free');
    assert.equal(inferPriceType('무료'), 'free');
  });
});
