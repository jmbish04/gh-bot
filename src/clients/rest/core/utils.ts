export function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function decodeBase64(content: string): string {
  if (typeof atob === 'function') {
    const binary = atob(content);
    const length = binary.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }
  return Buffer.from(content, 'base64').toString('utf-8');
}
