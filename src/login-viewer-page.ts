export const loginViewerPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ProDex Login</title>
  <link rel="stylesheet" href="/style.css">
  <script type="module" src="/app.js"></script>
</head>
<body>
  <header><h1>ProDex Login</h1><span id="state" role="status" aria-live="polite">Connecting</span><span id="detail" aria-live="polite"></span></header>
  <main><div id="screen" aria-label="Remote login desktop"></div></main>
</body>
</html>`;

export const loginViewerStyle = `:root { color-scheme: dark; font-family: system-ui, sans-serif; background: #101417; color: #f4f6f5; }
* { box-sizing: border-box; }
html, body { width: 100%; margin: 0; }
body { display: flex; flex-direction: column; height: 100dvh; min-height: 0; overflow: hidden; }
header { flex-shrink: 0; min-height: 56px; padding: 0 20px; display: flex; align-items: center; gap: 16px; border-bottom: 1px solid #344043; background: #1b2528; }
h1 { margin: 0; font-size: 16px; font-weight: 650; white-space: nowrap; }
#state { margin-left: auto; padding: 5px 10px; border: 1px solid #57746a; border-radius: 4px; color: #b9e9d4; font-size: 13px; line-height: 1.3; white-space: nowrap; }
#detail { min-width: 0; color: #c9d3d3; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
main { display: flex; flex: 1; min-height: 0; width: 100%; overflow: hidden; }
#screen { flex: 1; min-height: 0; width: 100%; }
#screen { display: flex; align-items: center; justify-content: center; overflow: hidden; background: #101417; }
#screen canvas { max-width: 100%; max-height: 100%; }
@media (max-width: 520px) { header { padding: 8px 12px; min-height: 56px; flex-wrap: wrap; gap: 4px 12px; } #detail { order: 3; width: 100%; } }
`;

const blockerLabels = {
  login_required: "Sign in required",
  cloudflare_check: "Security verification required",
  captcha_required: "Human verification required",
  permission_required: "Permission required"
};

export const loginViewerScript = `const state = document.getElementById('state');
const detail = document.getElementById('detail');
const blockerLabels = ${JSON.stringify(blockerLabels)};
const capability = location.hash.slice(1);
history.replaceState(null, '', location.pathname);

function show(label, message = '') {
  state.textContent = label;
  detail.textContent = message;
}

async function api(path, init = {}) {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('Viewer request failed');
  return response;
}

async function start() {
  if (capability) {
    await api('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability })
    });
  } else {
    await api('/status');
  }

  const { default: RFB } = await import('/novnc/core/rfb.js');
  const socketUrl = new URL('/websockify', location.href);
  socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const rfb = new RFB(document.getElementById('screen'), socketUrl.href);
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.addEventListener('credentialsrequired', async () => {
    try {
      const response = await api('/credentials');
      const { password } = await response.json();
      rfb.sendCredentials({ password });
    } catch {
      show('Unavailable', 'Viewer authentication failed');
      rfb.disconnect();
    }
  });
  rfb.addEventListener('connect', () => show('Connected'));
  rfb.addEventListener('disconnect', () => {
    if (state.textContent !== 'Ready') show('Disconnected');
  });

  let polling = false;
  const poll = async () => {
    if (polling || state.textContent === 'Ready') return;
    polling = true;
    try {
      const { ready, blocker } = await (await api('/status')).json();
      if (ready) {
        show('Ready');
        clearInterval(interval);
        setTimeout(() => rfb.disconnect(), 800);
      } else if (blocker) {
        show('Action needed', Object.hasOwn(blockerLabels, blocker) ? blockerLabels[blocker] : 'Check login screen');
      } else if (state.textContent !== 'Connected') {
        show('Connecting');
      }
    } catch {
      show('Unavailable', 'Viewer status is unavailable');
      clearInterval(interval);
      rfb.disconnect();
    } finally {
      polling = false;
    }
  };
  const interval = setInterval(poll, 1000);
  await poll();
}

start().catch(() => show('Unavailable', 'Viewer session is unavailable'));
`;
