import type { SceneTemplate } from '../types';

const templates: SceneTemplate[] = ['TitleSlide', 'CodeExplainer', 'BulletPoints', 'ImageFrame'];

interface Props {
  value: SceneTemplate;
  onChange: (value: SceneTemplate) => void;
}

export default function TemplateSelector({ value, onChange }: Props) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value as SceneTemplate)}>
      {templates.map((template) => (
        <option value={template} key={template}>
          {template}
        </option>
      ))}
    </select>
  );
}
