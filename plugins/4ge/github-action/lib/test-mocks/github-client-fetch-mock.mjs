import { readFileSync, writeFileSync } from 'node:fs';

const tracePath = process.env.GITHUB_CLIENT_TRACE_PATH;
const filesFixturePath = process.env.GITHUB_CLIENT_PR_FILES_FIXTURE;

const requests = [];

function writeTrace() {
  if (!tracePath) return;
  writeFileSync(tracePath, JSON.stringify(requests, null, 2), 'utf8');
}

function loadPrFiles() {
  if (!filesFixturePath) {
    return [
      { filename: 'src/app.tsx', patch: ['@@ -1,2 +1,2 @@', ' context', '+new'].join('\n') },
    ];
  }

  try {
    const raw = readFileSync(filesFixturePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (err) {
    throw new Error(`Failed to read pr files fixture: ${err.message}`);
  }

  return [];
}

const prFilesFixture = loadPrFiles();

global.fetch = async (url, options = {}) => {
  const parsedUrl = new URL(url);

  if (!parsedUrl.hostname.endsWith('api.github.com')) {
    throw new Error(`Unexpected fetch host for offline test: ${url}`);
  }

  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : undefined;

  const requestRecord = {
    method,
    url,
    body,
  };
  requests.push(requestRecord);
  writeTrace();

  if (parsedUrl.pathname.startsWith('/repos/') && parsedUrl.pathname.includes('/files')) {
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => prFilesFixture,
    };
  }

  if (parsedUrl.pathname.startsWith('/repos/') && parsedUrl.pathname.includes('/reviews')) {
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ ok: true }),
      json: async () => ({ id: 1, state: 'commented' }),
    };
  }

  // Fail fast if any unexpected endpoint is hit, preventing silent network leakage.
  throw new Error(`Unexpected endpoint in offline test: ${parsedUrl.pathname}`);
};
