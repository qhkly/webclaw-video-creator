import { Player, type PlayerRef } from '@remotion/player';
import {
  ArrowDown,
  ArrowUp,
  Clock3,
  Code2,
  Copy,
  Hash,
  Image,
  Layers3,
  List,
  ListPlus,
  Pause,
  Play,
  Quote,
  Sparkles,
  Trash2,
  Type,
  Volume2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { VideoComposition } from '../../remotion/src/VideoComposition';
import SceneVisual from '../components/SceneVisual';
import { templateLabels, templates } from '../components/TemplateSelector';
import { ASPECT_CSS, ASPECT_DIMENSIONS } from '../constants/aspect';
import { generateTts } from '../lib/tauri-bridge';
import { useVideoStore } from '../store/useVideoStore';
import { useI18n } from '../i18n';
import type { SceneTemplate } from '../types';

const TEMPLATE_ICONS = {
  TitleSlide: Type,
  BulletPoints: List,
  BigStat: Hash,
  Quote,
  CodeExplainer: Code2,
  ImageFrame: Image,
};

export default function SceneManager() {
  const scenes = useVideoStore((state) => state.scenes);
  const aspect = useVideoStore((state) => state.aspect);
  const voice = useVideoStore((state) => state.voice);
  const engine = useVideoStore((state) => state.engine);
  const setScenes = useVideoStore((state) => state.setScenes);
  const updateScene = useVideoStore((state) => state.updateScene);
  const moveScene = useVideoStore((state) => state.moveScene);
  const { t } = useI18n();
  const playerRef = useRef<PlayerRef>(null);
  const [selectedId, setSelectedId] = useState(() => scenes[0]?.id ?? '');
  const [advanced, setAdvanced] = useState(false);
  const [isScenePlaying, setIsScenePlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const selectedScene = useMemo(
    () => scenes.find((scene) => scene.id === selectedId) ?? scenes[0],
    [scenes, selectedId],
  );
  const totalSeconds = scenes.reduce((total, scene) => total + scene.duration, 0);
  const dimensions = ASPECT_DIMENSIONS[aspect];
  const playerStyle = {
    width: aspect === '16:9' ? '100%' : 'auto',
    height: aspect === '16:9' ? 'auto' : '100%',
    maxWidth: '100%',
    maxHeight: '100%',
    aspectRatio: ASPECT_CSS[aspect],
  };

  useEffect(() => {
    if (!selectedScene && scenes[0]) {
      setSelectedId(scenes[0].id);
    }
  }, [scenes, selectedScene]);

  if (!selectedScene) {
    return (
      <section className="page">
        <div className="empty-state">No scenes yet.</div>
      </section>
    );
  }

  const selectedIndex = Math.max(
    0,
    scenes.findIndex((scene) => scene.id === selectedScene.id),
  );
  const selectedDuration = Math.max(1, selectedScene.duration * 30);

  useEffect(() => {
    setCurrentFrame(0);
    setIsScenePlaying(false);
  }, [selectedScene.id]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) {
      return undefined;
    }
    const onPlay = () => setIsScenePlaying(true);
    const onPause = () => setIsScenePlaying(false);
    const onEnded = () => setIsScenePlaying(false);
    const onFrameUpdate = ({ detail }: { detail: { frame: number } }) => setCurrentFrame(detail.frame);

    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onEnded);
    player.addEventListener('frameupdate', onFrameUpdate);

    return () => {
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onEnded);
      player.removeEventListener('frameupdate', onFrameUpdate);
    };
  }, [selectedScene.id]);

  const addScene = () => {
    const next = {
      id: crypto.randomUUID(),
      title: '新场景',
      text: '',
      narration: '',
      template: 'TitleSlide' as SceneTemplate,
      duration: 5,
      props: { kicker: 'WEBCLAW', title: '新场景', subtitle: '从这里开始编辑', bgColor: '#0f172a' },
    };
    setScenes([...scenes, next]);
    setSelectedId(next.id);
  };

  const duplicateScene = () => {
    const copy = {
      ...selectedScene,
      id: crypto.randomUUID(),
      title: `${selectedScene.title} 副本`,
      props: { ...selectedScene.props },
      audio: undefined,
    };
    const nextScenes = [...scenes];
    nextScenes.splice(selectedIndex + 1, 0, copy);
    setScenes(nextScenes);
    setSelectedId(copy.id);
  };

  const deleteScene = () => {
    if (scenes.length <= 1) {
      return;
    }
    const nextScenes = scenes.filter((scene) => scene.id !== selectedScene.id);
    setScenes(nextScenes);
    setSelectedId(nextScenes[Math.max(0, selectedIndex - 1)].id);
  };

  const updateProps = (raw: string) => {
    try {
      updateScene(selectedScene.id, { props: JSON.parse(raw) as Record<string, unknown> });
    } catch {
      // Keep the last valid props while the user is typing invalid JSON.
    }
  };

  const updateProp = (key: string, value: unknown) => {
    updateScene(selectedScene.id, { props: { ...selectedScene.props, [key]: value } });
  };

  const toggleScenePlayback = (event: SyntheticEvent) => {
    const player = playerRef.current;
    if (!player) {
      return;
    }
    if (player.isPlaying()) {
      player.pause();
      setIsScenePlaying(false);
      return;
    }
    if (player.getCurrentFrame() >= selectedDuration - 1) {
      player.seekTo(0);
      setCurrentFrame(0);
    }
    player.play(event);
    setIsScenePlaying(true);
  };

  const seekScene = (frame: number) => {
    playerRef.current?.seekTo(frame);
    setCurrentFrame(frame);
  };

  const changeTemplate = (template: SceneTemplate) => {
    const existingBg = selectedScene.props.bgColor;
    const defaults =
      template === 'BulletPoints'
        ? { title: selectedScene.title, bullets: ['第一点', '第二点', '第三点'], bgColor: existingBg ?? '#0b1220' }
        : template === 'BigStat'
          ? { stat: '5×', label: selectedScene.title, bgColor: existingBg ?? '#134e4a' }
          : template === 'Quote'
            ? { quote: selectedScene.narration || selectedScene.title, author: 'WebClaw', bgColor: existingBg ?? '#0a0f1c' }
            : template === 'CodeExplainer'
              ? { caption: selectedScene.title, code: selectedScene.text || 'render(scenes)', bgColor: existingBg ?? '#0c1322' }
              : template === 'ImageFrame'
                ? { caption: selectedScene.title, subtitle: selectedScene.text || '产品截图 / B-roll', bgColor: existingBg ?? '#0b1220' }
                : { kicker: 'WEBCLAW', title: selectedScene.title, subtitle: selectedScene.text, bgColor: existingBg ?? '#0f172a' };
    updateScene(selectedScene.id, { template, props: defaults });
  };

  return (
    <section className="storyboard-layout">
      <aside className="scene-strip">
        <div className="strip-head">
          <div>
            <strong>分镜</strong>
            <span className="tag-dim">
              {scenes.length} 场景 · {totalSeconds}s
            </span>
          </div>
          <button className="btn btn-soft btn-icon" onClick={addScene} title="添加场景">
            <ListPlus size={16} />
          </button>
        </div>
        <div className="strip-list">
          {scenes.map((scene, index) => {
            const active = scene.id === selectedScene.id;
            return (
              <button
                key={scene.id}
                className={active ? 'scene-thumb active' : 'scene-thumb'}
                onClick={() => setSelectedId(scene.id)}
              >
                <div className="thumb-stage">
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <SceneVisual scene={scene} compact />
                  <em>{scene.duration}s</em>
                </div>
                <div className="thumb-meta">
                  <span>{scene.title}</span>
                  <small>{templateLabels[scene.template]}</small>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="storyboard-center">
        <div className="canvas-toolbar">
          <span className="pill pill-accent">
            <Sparkles size={13} />
            {templateLabels[selectedScene.template]}
          </span>
          <strong>{selectedScene.title}</strong>
          <div className="toolbar-actions">
            <button className="btn btn-icon btn-ghost" onClick={() => moveScene(selectedScene.id, -1)} title={t.sceneCard.moveUp}>
              <ArrowUp size={15} />
            </button>
            <button className="btn btn-icon btn-ghost" onClick={() => moveScene(selectedScene.id, 1)} title={t.sceneCard.moveDown}>
              <ArrowDown size={15} />
            </button>
            <button className="btn btn-icon btn-ghost" onClick={duplicateScene} title="复制">
              <Copy size={15} />
            </button>
            <button className="btn btn-icon btn-ghost" onClick={deleteScene} disabled={scenes.length <= 1} title="删除">
              <Trash2 size={15} />
            </button>
          </div>
        </div>
        <div className="canvas-area">
          <div className="scene-player-frame">
            <Player
              ref={playerRef}
              key={selectedScene.id}
              component={VideoComposition}
              inputProps={{ scenes: [selectedScene], aspect }}
              durationInFrames={selectedDuration}
              compositionWidth={dimensions.width}
              compositionHeight={dimensions.height}
              fps={30}
              controls={false}
              moveToBeginningWhenEnded
              style={playerStyle}
            />
          </div>
          <div className="scene-scrubber">
            <button className="btn btn-primary btn-icon" onClick={toggleScenePlayback} title={isScenePlaying ? '暂停' : '播放'}>
              {isScenePlaying ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <input
              className="scene-range"
              type="range"
              min={0}
              max={Math.max(0, selectedDuration - 1)}
              value={Math.min(currentFrame, selectedDuration - 1)}
              onChange={(event) => seekScene(Number(event.target.value))}
            />
            <small>
              {(Math.min(currentFrame, selectedDuration - 1) / 30).toFixed(1)}s / {selectedScene.duration}s
            </small>
          </div>
        </div>
      </div>

      <aside className="properties-panel">
        <div className="properties-head">{t.sceneManager.title}</div>
        <div className="properties-scroll">
          <label>
            <span className="field-label">场景名称</span>
            <input
              className="input"
              value={selectedScene.title}
              onChange={(event) => updateScene(selectedScene.id, { title: event.target.value })}
            />
          </label>
          <label>
            <span className="field-label">
              <Layers3 size={13} />
              {t.sceneCard.template}
            </span>
            <div className="template-grid">
              {templates.map((template) => {
                const Icon = TEMPLATE_ICONS[template];
                return (
                  <button
                    className={selectedScene.template === template ? 'active' : ''}
                    key={template}
                    onClick={() => changeTemplate(template)}
                  >
                    <Icon size={17} />
                    <span>{templateLabels[template]}</span>
                  </button>
                );
              })}
            </div>
          </label>
          <label>
            <span className="field-label">
              <Clock3 size={13} />
              {t.sceneCard.duration} · {selectedScene.duration}s
            </span>
            <input
              type="range"
              min={2}
              max={20}
              value={selectedScene.duration}
              onChange={(event) => updateScene(selectedScene.id, { duration: Number(event.target.value) })}
            />
          </label>
          <div className="template-fields">
            {selectedScene.template === 'TitleSlide' && (
              <>
                <label>
                  <span className="field-label">标签</span>
                  <input className="input" value={String(selectedScene.props.kicker ?? '')} onChange={(event) => updateProp('kicker', event.target.value)} />
                </label>
                <label>
                  <span className="field-label">主标题</span>
                  <input className="input" value={String(selectedScene.props.title ?? '')} onChange={(event) => updateProp('title', event.target.value)} />
                </label>
                <label>
                  <span className="field-label">副标题</span>
                  <input className="input" value={String(selectedScene.props.subtitle ?? '')} onChange={(event) => updateProp('subtitle', event.target.value)} />
                </label>
              </>
            )}
            {selectedScene.template === 'BulletPoints' && (
              <>
                <label>
                  <span className="field-label">标题</span>
                  <input className="input" value={String(selectedScene.props.title ?? '')} onChange={(event) => updateProp('title', event.target.value)} />
                </label>
                <label>
                  <span className="field-label">要点</span>
                  <textarea
                    className="textarea"
                    value={(Array.isArray(selectedScene.props.bullets) ? selectedScene.props.bullets : []).map(String).join('\n')}
                    onChange={(event) => updateProp('bullets', event.target.value.split('\n').filter(Boolean))}
                  />
                </label>
              </>
            )}
            {selectedScene.template === 'BigStat' && (
              <>
                <label>
                  <span className="field-label">数字</span>
                  <input className="input" value={String(selectedScene.props.stat ?? '')} onChange={(event) => updateProp('stat', event.target.value)} />
                </label>
                <label>
                  <span className="field-label">说明</span>
                  <input className="input" value={String(selectedScene.props.label ?? '')} onChange={(event) => updateProp('label', event.target.value)} />
                </label>
              </>
            )}
            {selectedScene.template === 'Quote' && (
              <>
                <label>
                  <span className="field-label">引文</span>
                  <textarea className="textarea" value={String(selectedScene.props.quote ?? '')} onChange={(event) => updateProp('quote', event.target.value)} />
                </label>
                <label>
                  <span className="field-label">署名</span>
                  <input className="input" value={String(selectedScene.props.author ?? '')} onChange={(event) => updateProp('author', event.target.value)} />
                </label>
              </>
            )}
            {selectedScene.template === 'CodeExplainer' && (
              <>
                <label>
                  <span className="field-label">标题</span>
                  <input className="input" value={String(selectedScene.props.caption ?? '')} onChange={(event) => updateProp('caption', event.target.value)} />
                </label>
                <label>
                  <span className="field-label">代码</span>
                  <textarea className="textarea mono small-mono" value={String(selectedScene.props.code ?? '')} onChange={(event) => updateProp('code', event.target.value)} />
                </label>
              </>
            )}
            {selectedScene.template === 'ImageFrame' && (
              <>
                <label>
                  <span className="field-label">字幕</span>
                  <input className="input" value={String(selectedScene.props.caption ?? '')} onChange={(event) => updateProp('caption', event.target.value)} />
                </label>
                <label>
                  <span className="field-label">说明</span>
                  <input className="input" value={String(selectedScene.props.subtitle ?? '')} onChange={(event) => updateProp('subtitle', event.target.value)} />
                </label>
              </>
            )}
            <label>
              <span className="field-label">背景色</span>
              <input className="input color-input" type="color" value={String(selectedScene.props.bgColor ?? '#0f172a')} onChange={(event) => updateProp('bgColor', event.target.value)} />
            </label>
          </div>
          <label>
            <span className="field-label">{t.sceneCard.narration}</span>
            <textarea
              className="textarea"
              value={selectedScene.narration}
              onChange={(event) => updateScene(selectedScene.id, { narration: event.target.value })}
            />
          </label>
          <button className="btn btn-ghost btn-sm advanced-toggle" onClick={() => setAdvanced(!advanced)}>
            <Code2 size={13} />
            {advanced ? '返回可视化编辑' : '高级 JSON 编辑'}
          </button>
          {advanced && (
            <label>
              <span className="field-label">{t.sceneCard.propsJson}</span>
              <textarea
                className="textarea mono"
                value={JSON.stringify(selectedScene.props, null, 2)}
                onChange={(event) => updateProps(event.target.value)}
                spellCheck={false}
              />
            </label>
          )}
          <div className="voice-state">
            {selectedScene.audio ? (
              <span className="pill pill-accent">{selectedScene.audio.duration.toFixed(1)}s</span>
            ) : (
              <span className="pill pill-muted">未生成配音</span>
            )}
            <button
              className="btn btn-soft btn-sm"
              onClick={async () => {
                const output = `${selectedScene.id}.mp3`;
                const duration = await generateTts({ text: selectedScene.narration, voice, output, engine });
                updateScene(selectedScene.id, { audio: { path: output, duration } });
              }}
            >
              <Volume2 size={14} />
              {t.sceneCard.generateTts}
            </button>
          </div>
        </div>
      </aside>
    </section>
  );
}
