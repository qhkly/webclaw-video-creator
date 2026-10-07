// Validation for the scenes JSON consumed by scripts/render.mjs and the Remotion
// composition. Mirrors `VideoScene` in src/types.ts — keep both in sync.
export const SCENE_TEMPLATES = ['TitleSlide', 'BulletPoints', 'BigStat', 'Quote', 'CodeExplainer', 'ImageFrame', 'CTA'];

export function validateScenes(scenes) {
  const errors = [];
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return ['scenes must be a non-empty array'];
  }
  const ids = new Set();
  scenes.forEach((scene, index) => {
    const at = `scenes[${index}]`;
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
      errors.push(`${at} must be an object`);
      return;
    }
    for (const key of ['id', 'title', 'text', 'narration']) {
      if (typeof scene[key] !== 'string') {
        errors.push(`${at}.${key} must be a string`);
      }
    }
    if (typeof scene.id === 'string') {
      if (ids.has(scene.id)) {
        errors.push(`${at}.id "${scene.id}" is duplicated`);
      }
      ids.add(scene.id);
    }
    if (!SCENE_TEMPLATES.includes(scene.template)) {
      errors.push(`${at}.template must be one of ${SCENE_TEMPLATES.join(', ')}`);
    }
    if (typeof scene.duration !== 'number' || !(scene.duration > 0)) {
      errors.push(`${at}.duration must be a positive number of seconds`);
    }
    if (scene.props === undefined || typeof scene.props !== 'object' || scene.props === null || Array.isArray(scene.props)) {
      errors.push(`${at}.props must be an object`);
    }
    if (scene.audio !== undefined && (typeof scene.audio?.path !== 'string' || typeof scene.audio?.duration !== 'number')) {
      errors.push(`${at}.audio must be { path: string, duration: number, wordsPath?: string }`);
    }
    if (scene.background !== undefined && !['video', 'image', 'none'].includes(scene.background?.kind)) {
      errors.push(`${at}.background.kind must be video | image | none`);
    }
    if (scene.captions !== undefined && !Array.isArray(scene.captions)) {
      errors.push(`${at}.captions must be an array of { text, startMs, durationMs }`);
    }
  });
  return errors;
}
