// Remotion's renderer only fetches http(s) URLs, so absolute local paths (TTS
// audio, downloaded backgrounds) cannot be rendered as `file://`. Before
// bundling, place each local file inside the bundle's publicDir and rewrite the
// scene path to `static:<relative>`, which remotion/src/media.ts resolves with
// staticFile(). The in-app Player never sees `static:` paths.
import { copyFile, link, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

export const STATIC_PREFIX = 'static:';

export async function stageSceneMedia(scenes, publicDir) {
  const stageDir = join(publicDir, '_render');
  const staged = new Map();

  async function stage(path) {
    if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path)) {
      return path;
    }
    if (!staged.has(path)) {
      const inside = relative(publicDir, path);
      if (inside && !inside.startsWith('..') && !isAbsolute(inside)) {
        staged.set(path, inside.split(sep).join('/'));
      } else {
        await mkdir(stageDir, { recursive: true });
        const name = `${createHash('sha1').update(path).digest('hex').slice(0, 10)}-${basename(path)}`;
        const target = join(stageDir, name);
        if (!existsSync(target)) {
          await link(path, target).catch(() => copyFile(path, target));
        }
        staged.set(path, `_render/${name}`);
      }
    }
    return `${STATIC_PREFIX}${staged.get(path)}`;
  }

  const result = [];
  for (const scene of scenes) {
    const next = { ...scene };
    if (scene.audio?.path) {
      next.audio = { ...scene.audio, path: await stage(scene.audio.path) };
    }
    if (scene.background?.assetPath) {
      next.background = { ...scene.background, assetPath: await stage(scene.background.assetPath) };
    }
    if (scene.template === 'ImageFrame' && scene.props?.imageSrc) {
      next.props = { ...scene.props, imageSrc: await stage(scene.props.imageSrc) };
    }
    result.push(next);
  }
  return result;
}
