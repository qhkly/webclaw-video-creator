import { useI18n } from '../i18n';
import type { VoiceEngine } from '../types';

const VOICE_KEYS = ['zh-CN-YunxiNeural', 'zh-CN-XiaoxiaoNeural', 'en-US-GuyNeural', 'en-US-JennyNeural'];

interface Props {
  voice: string;
  engine: VoiceEngine;
  onVoiceChange: (voice: string) => void;
  onEngineChange: (engine: VoiceEngine) => void;
}

export default function VoiceSelector({ voice, engine, onVoiceChange, onEngineChange }: Props) {
  const { t } = useI18n();

  return (
    <div className="voice-grid">
      <label>
        <span className="field-label">{t.voiceSelector.engine}</span>
        <select className="select" value={engine} onChange={(event) => onEngineChange(event.target.value as VoiceEngine)}>
          <option value="edge">Edge TTS</option>
          <option value="f5">F5-TTS</option>
        </select>
      </label>
      <label>
        <span className="field-label">{t.voiceSelector.voice}</span>
        <select className="select" value={voice} onChange={(event) => onVoiceChange(event.target.value)}>
          {VOICE_KEYS.map((key) => (
            <option value={key} key={key}>
              {t.voices[key] ?? key}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
