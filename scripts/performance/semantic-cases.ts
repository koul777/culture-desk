export function semanticCases(snapshot: any) {
  const coverage = { from: snapshot.coverage.from, to: snapshot.coverage.to };
  const queries: [string, Record<string, string>][] = [
    ['national', {}], ['regional', { cities: 'yeosu,wonju' }], ['capital', { cities: 'region-1111' }],
    ['city-empty', { cities: 'not-a-city' }], ['empty-text', { q: '__NO_MATCH_EXPECTED_20261019__' }],
    ['korean-text', { q: '음악' }], ['unicode-title', { q: snapshot.performances.find((row: any) => row.title)?.title.slice(0, 5) }],
    ['venue', { q: snapshot.performances.find((row: any) => row.venue)?.venue.slice(0, 5) }],
    ['music', { genre: '음악' }], ['theatre', { genre: '연극' }], ['free', { price: 'free' }], ['paid', { price: 'paid' }],
    ['unknown-price', { price: 'unknown' }], ['age', { age: '8' }], ['kopis', { source: 'kopis' }], ['culture', { source: 'culture' }],
    ['ongoing', { status: 'ongoing' }], ['upcoming', { status: 'upcoming' }], ['ended', { status: 'ended' }],
    ['first-day', { to: coverage.from }], ['last-day', { from: coverage.to }], ['outside-coverage', { from: '2040-01-01', to: '2040-01-31' }],
    ['combined', { cities: 'yeosu,wonju', source: 'kopis', price: 'free', q: '음악' }],
    ['page-two', { page: '2', limit: '30' }], ['page-clamp', { page: '1000000', limit: '100' }], ['single-item', { limit: '1' }],
  ];
  const cases = queries.flatMap(([name, query]) => ['/api/performances', '/api/map'].map(endpoint => ({ name: `${name}:${endpoint}`, method: 'GET',
    route: `${endpoint}?${new URLSearchParams({ ...coverage, ...query })}` })));
  const first = snapshot.performances[0], last = snapshot.performances.at(-1);
  cases.push({ name: 'bootstrap', method: 'GET', route: '/api/bootstrap' },
    { name: 'detail-first', method: 'GET', route: `/api/performances/${first.id}` },
    { name: 'detail-last', method: 'GET', route: `/api/performances/${last.id}` },
    { name: 'detail-missing', method: 'GET', route: '/api/performances/2147483647' },
    { name: 'head-map', method: 'HEAD', route: `/api/map?${new URLSearchParams(coverage)}` },
    { name: 'invalid-limit', method: 'GET', route: '/api/performances?limit=101' },
    { name: 'invalid-date', method: 'GET', route: '/api/map?from=2026-02-30' },
    { name: 'reversed-date', method: 'GET', route: '/api/map?from=2026-10-31&to=2026-10-01' },
    { name: 'readonly-bookmark', method: 'GET', route: '/api/performances?bookmarked=true' },
    { name: 'readonly-mutation', method: 'POST', route: '/api/details' },
    { name: 'export-regional', method: 'GET', route: `/api/export.xlsx?${new URLSearchParams({ ...coverage, cities: 'yeosu,wonju' })}` },
    { name: 'export-empty', method: 'GET', route: `/api/export.xlsx?${new URLSearchParams({ ...coverage, q: '__NO_MATCH_EXPECTED_20261019__' })}` });
  return cases;
}
