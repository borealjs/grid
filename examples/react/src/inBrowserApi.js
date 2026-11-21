// A `fetch` for createHttpSource that answers /api calls in the browser with the reference backend's own
// code (demo-backend.mjs, the same module server.mjs serves over HTTP). The static demo on GitHub Pages
// uses it, so the server tabs work without a server. The backend is loaded on first use.

let backend;

/** fetch(href, init) for /api URLs: same requests and JSON responses as the reference server. */
export async function inBrowserFetch(href, init = {}) {
  const { signal } = init;
  const aborted = () => new DOMException('Aborted', 'AbortError');
  if (signal?.aborted) throw aborted();
  backend ??= import('../../../demo-backend.mjs');
  const { handleApiRequest } = await backend;
  let out;
  try {
    out = await handleApiRequest({
      url: new URL(href, location.href),
      method: init.method ?? 'GET',
      readBody: async () => JSON.parse(init.body ?? 'null'),
      cancelled: () => signal?.aborted === true,
    });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    out = { status: err.status, body: { error: err.message } };
  }
  if (!out || signal?.aborted) throw aborted();
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
}
