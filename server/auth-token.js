export function readCookieValue(cookieHeader, name) {
  if (!cookieHeader || !name) return "";
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const value = trimmed.slice(name.length + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return "";
}

export function resolveRequestAuthToken({ authorization, protocolHeader, cookieHeader }) {
  const headerToken = authorization?.replace(/^Bearer\s+/i, "") || "";
  if (headerToken) return headerToken;

  const protocolToken = String(protocolHeader || "")
    .split(',')
    .map((value) => value.trim())
    .find((value) => value.startsWith('token.'))
    ?.slice(6);
  if (protocolToken) return protocolToken;

  return readCookieValue(cookieHeader, 'hana_token');
}
