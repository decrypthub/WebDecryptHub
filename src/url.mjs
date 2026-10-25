const HOST_WITH_PORT = /^(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\]):\d+(?:[/?#]|$)/i;
const LOCAL_HOST_WITH_PORT = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]):\d+(?:[/?#]|$)/i;

export function normalizeTargetUrl(value) {
  const input = String(value ?? '').trim();
  if (!input || input === 'https://') return '';
  if (/^https?:\/\//i.test(input) || /^about:blank$/i.test(input)) return input;
  if (/^[a-z][a-z\d+.-]*:/i.test(input) && !HOST_WITH_PORT.test(input)) {
    throw new Error('只支持 HTTP 或 HTTPS 网站地址。');
  }
  return `${LOCAL_HOST_WITH_PORT.test(input) ? 'http' : 'https'}://${input}`;
}
