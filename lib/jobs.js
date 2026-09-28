'use strict';
const jobs = new Map();
let seq = 1;

function create(kind, fn) {
  const job = { id: String(seq++), kind, status: 'running', done: 0, total: 0, found: 0, fresh: 0, requests: 0, message: '', error: '', note: '', started: Date.now(), ctl: new AbortController() };
  jobs.set(job.id, job);
  Promise.resolve().then(() => fn(job, job.ctl.signal)).then(() => {
    job.status = job.ctl.signal.aborted ? 'stopped' : 'done';
    job.ended = Date.now();
  }).catch((e) => { job.status = 'error'; job.error = e && e.message || String(e); job.ended = Date.now(); });
  for (const [id, j] of jobs) if (j.ended && Date.now() - j.ended > 3600e3) jobs.delete(id);
  return job;
}
const get = (id) => jobs.get(String(id));
const view = (j) => j && ({ id: j.id, kind: j.kind, status: j.status, done: j.done, total: j.total, found: j.found, fresh: j.fresh, requests: j.requests, message: j.message, error: j.error, note: j.note, elapsed: (j.ended || Date.now()) - j.started, meta: j.meta || null });
const stop = (id) => { const j = get(id); if (j) j.ctl.abort(); return !!j; };
const running = (kind) => [...jobs.values()].find((j) => j.kind === kind && j.status === 'running');

module.exports = { create, get, view, stop, running };
