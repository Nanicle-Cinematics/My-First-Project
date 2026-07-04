'use strict';

const base = process.argv[2] || 'http://127.0.0.1:3000';
const requests = Number(process.env.LOAD_REQUESTS || 200);
const concurrency = Number(process.env.LOAD_CONCURRENCY || 20);
const maxP95 = Number(process.env.LOAD_MAX_P95_MS || 1500);
const samples = [];
let failures = 0;
let issued = 0;

async function worker() {
  while (issued < requests) {
    issued++;
    const started = performance.now();
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
      samples.push(performance.now() - started);
      if (!response.ok) failures++;
    } catch (_) {
      failures++;
    }
  }
}

Promise.all(Array.from({ length: concurrency }, worker)).then(() => {
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] || Infinity;
  console.log(JSON.stringify({ requests, concurrency, successes: samples.length, failures, p95Ms: Math.round(p95) }));
  if (failures || p95 > maxP95) process.exit(1);
});
