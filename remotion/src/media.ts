export function mediaSrc(path?: string) {
  if (!path) {
    return '';
  }
  if (/^(https?:|file:|data:|blob:)/.test(path)) {
    return path;
  }
  if (path.startsWith('/')) {
    return `file://${path}`;
  }
  return path;
}
