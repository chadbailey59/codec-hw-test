// Summarizes every submission stored by the server.

function os(env) {
  const d = env.uaData;
  if (d && d.platform) return `${d.platform} ${d.platformVersion || ''}`.trim();
  const ua = env.userAgent || '';
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'unknown';
}

function browser(env) {
  const b = env.browser || {};
  return `${b.name || '?'} ${(b.version || '').split('.')[0]}`.trim();
}

function gpu(env) {
  return (env.gpu && env.gpu.renderer) || (env.webgpu && env.webgpu.description) || '?';
}

function table(el, headers, rows) {
  el.innerHTML = '';
  const thead = el.createTHead().insertRow();
  for (const h of headers) {
    const th = document.createElement('th');
    th.textContent = h;
    thead.append(th);
  }
  const tbody = el.createTBody();
  for (const r of rows) {
    const tr = tbody.insertRow();
    for (const c of r) tr.insertCell().textContent = c === undefined || c === null ? '' : String(c);
  }
  if (!rows.length) tbody.insertRow().insertCell().textContent = 'None yet.';
}

async function main() {
  const res = await fetch('/api/results');
  const subs = await res.json();
  document.getElementById('status').textContent = `${subs.length} submissions.`;

  const groups = new Map();
  const misses = [];
  for (const s of subs) {
    const env = s.environment || {};
    for (const r of s.results || []) {
      for (const dir of ['encode', 'decode']) {
        const v = r[`${dir}Verdict`];
        if (!v) continue;
        const key = `${browser(env)}|${os(env)}|${dir}`;
        const g = groups.get(key) || { browser: browser(env), os: os(env), dir, agree: 0, disagree: 0, unknown: 0 };
        if (v.agree === true) g.agree++;
        else if (v.agree === false) g.disagree++;
        else g.unknown++;
        groups.set(key, g);
        if (v.agree === false) {
          const side = (r.webrtc || {})[dir] || {};
          misses.push([s.name || s.id, browser(env), os(env), gpu(env), r.label, dir, v.predicted, v.observed,
            (side.implementations || []).join(' → ') || side.implementation, v.observedFrom]);
        }
      }
    }
  }

  table(document.getElementById('byBrowser'),
    ['Browser', 'OS', 'Direction', 'Agree', 'Disagree', "Can't tell", 'Accuracy'],
    [...groups.values()]
      .sort((a, b) => a.browser.localeCompare(b.browser) || a.os.localeCompare(b.os) || a.dir.localeCompare(b.dir))
      .map((g) => [g.browser, g.os, g.dir, g.agree, g.disagree, g.unknown,
        g.agree + g.disagree ? `${Math.round((100 * g.agree) / (g.agree + g.disagree))}%` : '—']));

  table(document.getElementById('misses'),
    ['Who', 'Browser', 'OS', 'GPU', 'Codec', 'Direction', 'Browser said', 'Ran', 'Implementation', 'Observed from'],
    misses);

  table(document.getElementById('submissions'),
    ['Received', 'Who', 'Model', 'Browser', 'OS', 'GPU', 'Codecs', 'Ground truth pasted'],
    subs.slice().reverse().map((s) => {
      const env = s.environment || {};
      return [s.receivedAt, s.name || '', s.model || '', browser(env), os(env), gpu(env), (s.results || []).length, s.groundTruth ? 'yes' : 'no'];
    }));
}

main().catch((e) => { document.getElementById('status').textContent = `Couldn't load results: ${e.message}`; });
