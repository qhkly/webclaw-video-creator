import { staticFile } from 'remotion';

export function mediaSrc(path?: string) {
  if (!path) {
    return '';
  }
  // Written by scripts/render.mjs after staging local files into the bundle publicDir.
  if (path.startsWith('static:')) {
    return staticFile(path.slice('static:'.length));
  }
  if (/^(https?:|file:|data:|blob:)/.test(path)) {
    return path;
  }
  if (path.startsWith('/')) {
    return `file://${path}`;
  }
  return path;
}
