import { convertFileSrc } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
  AlertTriangle,
  AudioLines,
  Check,
  Download,
  Eye,
  FileVideo,
  Pause,
  Pencil,
  Play,
  Redo2,
  RefreshCw,
  RotateCcw,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildTimeline,
  computeKeepRanges,
  formatTime,
  nextPlayableTime,
  sourceToOutput,
  suggestCuts,
  totalDuration,
  type TimelineUnit,
  type TranscriptSegment,
} from '../lib/cut-plan';
import { allowMediaPreview, exportCut, onCutterProgress, transcribeVideo } from '../lib/tauri-bridge';
import { FeatureGateNotice, useGate } from '../components/AccountPanel';
import { usePlanLimits } from '../store/useAccountStore';
import { useI18n } from '../i18n';
import { useCutterStore } from '../store/useCutterStore';
import { useVideoStore } from '../store/useVideoStore';
import type { CutterProgress } from '../types';

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'];
const PAUSE_THRESHOLD = 0.8;

type Block = { kind: 'segment'; segment: TranscriptSegment; units: TimelineUnit[] } | { kind: 'gap'; unit: TimelineUnit };

export default function CutterPage() {
  const asr = useVideoStore((state) => state.settings.asr);
  const { videoPath, transcript, cuts, past, future } = useCutterStore();
  const { loadVideo, setTranscript, toggleCuts, cutUnits, restoreUnits, revertAi, editSegmentText, undo, redo } = useCutterStore();
  const { t } = useI18n();
  const cleanupGate = useGate('cutter.aiCleanup');
  const planLimits = usePlanLimits();

  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewCut, setPreviewCut] = useState(true);
  const [busy, setBusy] = useState<CutterProgress['task'] | null>(null);
  const [progress, setProgress] = useState<CutterProgress | null>(null);
  const [error, setError] = useState('');
  const [exported, setExported] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [previewSrc, setPreviewSrc] = useState('');

  const duration = transcript?.duration || mediaDuration;
  const units = useMemo(() => (transcript ? buildTimeline(transcript) : []), [transcript]);
  const ranges = useMemo(
    () => (transcript ? computeKeepRanges(units, cuts) : duration > 0 ? [{ start: 0, end: duration }] : []),
    [transcript, units, cuts, duration],
  );
  const keptSeconds = totalDuration(ranges);
  const aiCount = Object.values(cuts).filter((source) => source === 'ai').length;
  const cutCount = Object.keys(cuts).length;
  const fileName = videoPath.split(/[\\/]/).pop() ?? '';
  const outputTime = sourceToOutput(ranges, currentTime);

  const blocks = useMemo(() => {
    const result: Block[] = [];
    const segments = new Map(transcript?.segments.map((segment) => [segment.id, segment]));
    for (const unit of units) {
      const last = result[result.length - 1];
      if (unit.kind === 'gap') {
        result.push({ kind: 'gap', unit });
      } else if (last?.kind === 'segment' && last.segment.id === unit.segmentId) {
        last.units.push(unit);
      } else {
        const segment = segments.get(unit.segmentId ?? '');
        if (segment) {
          result.push({ kind: 'segment', segment, units: [unit] });
        }
      }
    }
    return result;
  }, [transcript, units]);

  // Preview access is granted per file (asset protocol scope is empty by default).
  useEffect(() => {
    setPreviewSrc('');
    if (!videoPath) {
      return;
    }
    let cancelled = false;
    allowMediaPreview(videoPath)
      .then((path) => !cancelled && setPreviewSrc(convertFileSrc(path)))
      .catch((caught) => !cancelled && setError(`无法打开视频：${String(caught)}`));
    return () => {
      cancelled = true;
    };
  }, [videoPath]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void onCutterProgress(setProgress)
      .then((unlisten) => (cleanup = unlisten))
      .catch(() => {});
    return () => cleanup?.();
  }, []);

  // Playback loop: track time precisely and, in cut-preview mode, jump over removed ranges.
  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) {
        if (previewCut && transcript) {
          const next = nextPlayableTime(ranges, video.currentTime);
          if (next === null) {
            video.pause();
          } else if (next - video.currentTime > 0.03) {
            video.currentTime = next;
          }
        }
        setCurrentTime(video.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, previewCut, ranges, transcript]);

  const seek = useCallback((time: number) => {
    const video = videoRef.current;
    if (video) {
      video.currentTime = time;
      setCurrentTime(time);
    }
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (video.paused) {
      if (previewCut && transcript && nextPlayableTime(ranges, video.currentTime) === null) {
        video.currentTime = ranges[0]?.start ?? 0;
      }
      void video.play();
    } else {
      video.pause();
    }
  }, [previewCut, ranges, transcript]);

  const selectedUnitIds = useCallback(() => {
    const selection = window.getSelection();
    const container = transcriptRef.current;
    if (!selection || selection.isCollapsed || !container) {
      return [];
    }
    return Array.from(container.querySelectorAll<HTMLElement>('[data-unit-id]'))
      .filter((element) => selection.containsNode(element, true))
      .map((element) => element.dataset.unitId as string);
  }, []);

  const cutSelection = useCallback(
    (mode: 'toggle' | 'restore' = 'toggle') => {
      const ids = selectedUnitIds();
      if (ids.length === 0) {
        return false;
      }
      if (mode === 'restore') {
        restoreUnits(ids);
      } else {
        toggleCuts(ids);
      }
      window.getSelection()?.removeAllRanges();
      return true;
    },
    [restoreUnits, selectedUnitIds, toggleCuts],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || (event.key === ' ' && target.tagName === 'BUTTON'))) {
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && cutSelection()) {
        event.preventDefault();
      } else if (event.key === ' ' && videoPath) {
        event.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cutSelection, redo, togglePlay, undo, videoPath]);

  const importVideo = async () => {
    const selected = await open({ multiple: false, filters: [{ name: 'Video', extensions: VIDEO_EXTENSIONS }] });
    if (typeof selected === 'string') {
      loadVideo(selected);
      setMediaDuration(0);
      setCurrentTime(0);
      setError('');
      setExported('');
      setProgress(null);
    }
  };

  const runTranscribe = async () => {
    if (transcript && cutCount > 0 && !window.confirm('重新转写会清空当前剪辑决策，继续？')) {
      return;
    }
    setBusy('transcribe');
    setError('');
    setProgress({ task: 'transcribe', percent: 0, message: '准备转写…' });
    try {
      const result = await transcribeVideo({
        videoPath,
        provider: asr.provider,
        options: {
          baseUrl: asr.baseUrl,
          apiKey: asr.apiKey,
          model: asr.model,
          language: asr.language,
          whisperBin: asr.whisperBin,
          whisperModel: asr.whisperModel,
        },
      });
      setTranscript(result);
      setProgress({ task: 'transcribe', percent: 100, message: `转写完成 · ${result.segments.length} 段` });
    } catch (caught) {
      const fallbackHint =
        asr.provider === 'openai' || asr.provider === 'whisper-cpp'
          ? '（可在「设置 → 语音识别」切换为「自动」，识别失败时会降级为按停顿切分）'
          : '';
      setError(`${String(caught)}${fallbackHint}`);
      setProgress(null);
    } finally {
      setBusy(null);
    }
  };

  const runExport = async () => {
    const base = videoPath.replace(/\.[^./\\]+$/, '');
    const outputPath = await save({ defaultPath: `${base}_cut.mp4`, filters: [{ name: 'MP4', extensions: ['mp4'] }] });
    if (!outputPath) {
      return;
    }
    setBusy('export');
    setError('');
    setExported('');
    setProgress({ task: 'export', percent: 0, message: '准备导出…' });
    try {
      setExported(await exportCut({ videoPath, ranges, outputPath }));
    } catch (caught) {
      setError(String(caught));
      setProgress(null);
    } finally {
      setBusy(null);
    }
  };

  const applySuggestion = (kind: 'fillers' | 'pauses') => {
    // AI cleanup is a local heuristic whose result is ordinary cut ranges, so this is its gate.
    if (!cleanupGate.allowed) {
      return;
    }
    const ids = suggestCuts(units, kind === 'fillers' ? { fillers: true } : { pausesLongerThan: PAUSE_THRESHOLD });
    if (ids.length === 0) {
      setProgress({ task: 'transcribe', percent: 100, message: kind === 'fillers' ? '没有发现语气词' : '没有发现长停顿' });
      return;
    }
    cutUnits(ids, 'ai');
  };

  const unitClass = (unit: TimelineUnit) => {
    const classes = ['cut-unit'];
    if (cuts[unit.id]) {
      classes.push(cuts[unit.id] === 'ai' ? 'is-cut-ai' : 'is-cut');
    }
    if (currentTime >= unit.start && currentTime < unit.end) {
      classes.push('is-active');
    }
    return classes.join(' ');
  };

  return (
    <section className="page cutter-page rise">
      <header className="page-head head-row">
        <div>
          <h1>文字剪辑</h1>
          <p>导入口播 / 演示视频，删掉文字即剪掉画面，预览后用 FFmpeg 导出成片。</p>
        </div>
        <div className="header-pills">
          {videoPath && (
            <span className="pill pill-muted" title={videoPath}>
              <FileVideo size={13} />
              {fileName}
            </span>
          )}
          {duration > 0 && (
            <span className="pill pill-accent">
              {formatTime(duration)} → {formatTime(keptSeconds)}
            </span>
          )}
        </div>
      </header>

      {!videoPath ? (
        <div className="card cutter-empty">
          <Scissors size={28} />
          <strong>从一个本地视频开始</strong>
          <p className="tag-dim">支持 {VIDEO_EXTENSIONS.join(' / ')}。原视频不会被修改。</p>
          <button className="btn btn-primary" onClick={importVideo}>
            <FileVideo size={16} />
            导入视频
          </button>
        </div>
      ) : (
        <div className="cutter-grid">
          <div className="cutter-left">
            <div className="card cutter-player">
              <video
                ref={videoRef}
                src={previewSrc || undefined}
                onLoadedMetadata={(event) => setMediaDuration(event.currentTarget.duration || 0)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onError={() => setError('无法在预览中播放该视频（编码可能不受 WebView 支持），仍可转写与导出。')}
                onClick={togglePlay}
              />
              <div className="cutter-controls">
                <button className="btn btn-ghost btn-sm" onClick={togglePlay}>
                  {playing ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <span className="cutter-time">
                  源 {formatTime(currentTime)}
                  {transcript && ` · 成片 ${outputTime === null ? '已剪掉' : formatTime(outputTime)}`}
                </span>
                <label className="cutter-toggle" title="播放时自动跳过被删除的片段">
                  <input type="checkbox" checked={previewCut} onChange={(event) => setPreviewCut(event.target.checked)} />
                  <Eye size={13} />
                  预览剪辑效果
                </label>
              </div>
              {duration > 0 && (
                <div
                  className="cutter-strip"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    seek(((event.clientX - rect.left) / rect.width) * duration);
                  }}
                >
                  {ranges.map((range) => (
                    <span
                      key={range.start}
                      className="keep"
                      style={{ left: `${(range.start / duration) * 100}%`, width: `${((range.end - range.start) / duration) * 100}%` }}
                    />
                  ))}
                  <i style={{ left: `${(currentTime / duration) * 100}%` }} />
                </div>
              )}
            </div>

            <div className="card cutter-actions">
              <div className="cutter-stats">
                <div>
                  <small>原时长</small>
                  <strong>{formatTime(duration)}</strong>
                </div>
                <div>
                  <small>成片</small>
                  <strong>{formatTime(keptSeconds)}</strong>
                </div>
                <div>
                  <small>保留片段</small>
                  <strong>{ranges.length}</strong>
                </div>
              </div>
              {progress && (
                <div className="cutter-progress">
                  <div className="progress-track">
                    <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
                  </div>
                  <p className="progress-text">{progress.message}</p>
                </div>
              )}
              {error && (
                <p className="cutter-error">
                  <AlertTriangle size={14} />
                  {error}
                </p>
              )}
              {exported && <p className="result-path">已导出：{exported}</p>}
              {planLimits.watermark && <p className="account-note">{t.account.freeExportNote}</p>}
              <div className="cutter-buttons">
                <button className="btn btn-ghost btn-sm" onClick={importVideo} disabled={Boolean(busy)}>
                  <FileVideo size={14} />
                  更换视频
                </button>
                <button className="btn btn-soft btn-sm" onClick={runTranscribe} disabled={Boolean(busy)}>
                  {busy === 'transcribe' ? <RefreshCw size={14} className="spin" /> : <AudioLines size={14} />}
                  {transcript ? '重新转写' : '转写'}
                </button>
                <button className="btn btn-primary btn-sm" onClick={runExport} disabled={Boolean(busy) || ranges.length === 0}>
                  {busy === 'export' ? <RefreshCw size={14} className="spin" /> : <Download size={14} />}
                  导出 MP4
                </button>
              </div>
            </div>
          </div>

          <div className="card cutter-transcript">
            <div className="card-toolbar">
              <span>转写文本</span>
              {transcript && <span className="tag-dim">{transcript.provider}</span>}
              <div className="cutter-tools">
                <button className="btn btn-ghost btn-sm icon-only" onClick={undo} disabled={past.length === 0} title="撤销 (⌘Z)">
                  <Undo2 size={14} />
                </button>
                <button className="btn btn-ghost btn-sm icon-only" onClick={redo} disabled={future.length === 0} title="重做 (⇧⌘Z)">
                  <Redo2 size={14} />
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => cutSelection('toggle')} disabled={!transcript} title="删除 / 恢复选中的文字 (Delete)">
                  <Trash2 size={14} />
                  删除所选
                </button>
              </div>
            </div>
            {transcript && (
              <div className="cutter-ai">
                <Sparkles size={13} />
                <button className="btn btn-soft btn-sm" disabled={!cleanupGate.allowed} onClick={() => applySuggestion('fillers')}>
                  去语气词
                </button>
                <button className="btn btn-soft btn-sm" disabled={!cleanupGate.allowed} onClick={() => applySuggestion('pauses')}>
                  删长停顿 &gt;{PAUSE_THRESHOLD}s
                </button>
                {aiCount > 0 && (
                  <button className="btn btn-ghost btn-sm" onClick={revertAi} title="恢复所有 AI 删除的内容">
                    <RotateCcw size={13} />
                    撤销 AI 改动（{aiCount}）
                  </button>
                )}
              </div>
            )}
            {transcript && <FeatureGateNotice access={cleanupGate.access} message={t.account.proOnly.cleanup} />}
            {transcript?.warning && (
              <p className="cutter-warning">
                <AlertTriangle size={14} />
                {transcript.warning}
              </p>
            )}
            <div className="cutter-text" ref={transcriptRef}>
              {!transcript && (
                <div className="cutter-placeholder">
                  <p>点击「转写」生成可编辑文本。</p>
                  <p className="tag-dim">
                    当前引擎：{asr.provider}。未配置语音识别时会按停顿切分为片段，同样可以按片段剪辑；在「设置」中可配置 OpenAI 兼容接口或本地 whisper.cpp。
                  </p>
                </div>
              )}
              {blocks.map((block) => {
                if (block.kind === 'gap') {
                  const unit = block.unit;
                  return (
                    <span
                      key={unit.id}
                      data-unit-id={unit.id}
                      className={`${unitClass(unit)} cutter-gap`}
                      onClick={() => toggleCuts([unit.id])}
                      title="停顿：点击删除 / 恢复"
                    >
                      ⏸ {(unit.end - unit.start).toFixed(1)}s
                    </span>
                  );
                }
                const { segment } = block;
                const allCut = block.units.every((unit) => cuts[unit.id]);
                const isEditing = editing?.id === segment.id;
                return (
                  <div key={segment.id} className={allCut ? 'cutter-seg seg-cut' : 'cutter-seg'}>
                    <div className="seg-meta">
                      <button className="seg-time" onClick={() => seek(segment.start)}>
                        {formatTime(segment.start)}
                      </button>
                      <button className="seg-btn" title={allCut ? '恢复整段' : '删除整段'} onClick={() => toggleCuts(block.units.map((unit) => unit.id))}>
                        {allCut ? <RotateCcw size={12} /> : <Trash2 size={12} />}
                      </button>
                      <button className="seg-btn" title="修改文字" onClick={() => setEditing({ id: segment.id, text: segment.text })}>
                        <Pencil size={12} />
                      </button>
                    </div>
                    {isEditing ? (
                      <div className="seg-edit">
                        <textarea
                          className="textarea"
                          autoFocus
                          value={editing.text}
                          onChange={(event) => setEditing({ id: segment.id, text: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault();
                              editSegmentText(segment.id, editing.text.trim());
                              setEditing(null);
                            } else if (event.key === 'Escape') {
                              setEditing(null);
                            }
                          }}
                        />
                        <button
                          className="seg-btn"
                          title="保存 (Enter)"
                          onClick={() => {
                            editSegmentText(segment.id, editing.text.trim());
                            setEditing(null);
                          }}
                        >
                          <Check size={13} />
                        </button>
                        <button className="seg-btn" title="取消 (Esc)" onClick={() => setEditing(null)}>
                          <X size={13} />
                        </button>
                      </div>
                    ) : (
                      <p className="seg-text">
                        {block.units.map((unit) => (
                          <span key={unit.id} data-unit-id={unit.id} className={unitClass(unit)} onClick={() => seek(unit.start)}>
                            {unit.text}
                            {unit.kind === 'word' && /[A-Za-z0-9]$/.test(unit.text) ? ' ' : ''}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            {transcript && (
              <div className="card-footer">
                <span>
                  选中文字按 Delete 删除 / 再次删除可恢复 · 点击文字跳转 · 已删除 {cutCount} 处
                  {aiCount > 0 && <span className="ai-badge">AI {aiCount}</span>}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
