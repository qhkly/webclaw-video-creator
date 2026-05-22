import type { VoiceEngine } from '../types';

const voices = [
  { value: 'zh-CN-YunxiNeural', label: '中文男声 Yunxi' },
  { value: 'zh-CN-XiaoxiaoNeural', label: '中文女声 Xiaoxiao' },
  { value: 'en-US-GuyNeural', label: 'English Guy' },
  { value: 'en-US-JennyNeural', label: 'English Jenny' },
];

interface Props {
  voice: string;
  engine: VoiceEngine;
  onVoiceChange: (voice: string) => void;
  onEngineChange: (engine: VoiceEngine) => void;
}

export default function VoiceSelector({ voice, engine, onVoiceChange, onEngineChange }: Props) {
  return (
    <div className="voice-grid">
      <label>
        <span>引擎</span>
        <select value={engine} onChange={(event) => onEngineChange(event.target.value as VoiceEngine)}>
          <option value="edge">Edge TTS</option>
          <option value="f5">F5-TTS</option>
        </select>
      </label>
      <label>
        <span>音色</span>
        <select value={voice} onChange={(event) => onVoiceChange(event.target.value)}>
          {voices.map((item) => (
            <option value={item.value} key={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
