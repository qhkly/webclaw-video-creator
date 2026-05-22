import SceneCard from '../components/SceneCard';
import { generateTts } from '../lib/tauri-bridge';
import { useVideoStore } from '../store/useVideoStore';

export default function SceneManager() {
  const scenes = useVideoStore((state) => state.scenes);
  const voice = useVideoStore((state) => state.voice);
  const engine = useVideoStore((state) => state.engine);
  const updateScene = useVideoStore((state) => state.updateScene);
  const moveScene = useVideoStore((state) => state.moveScene);

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1>场景管理器</h1>
          <p>编辑模板、旁白、时长和渲染参数</p>
        </div>
      </header>
      <div className="scene-list">
        {scenes.map((scene, index) => (
          <SceneCard
            scene={scene}
            index={index}
            key={scene.id}
            onUpdate={(patch) => updateScene(scene.id, patch)}
            onMove={(direction) => moveScene(scene.id, direction)}
            onGenerateTts={async () => {
              const output = `${scene.id}.mp3`;
              const duration = await generateTts({ text: scene.narration, voice, output, engine });
              updateScene(scene.id, { audio: { path: output, duration } });
            }}
          />
        ))}
      </div>
    </section>
  );
}
