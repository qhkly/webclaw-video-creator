import type { SceneTemplate } from '../types';

export const templates: SceneTemplate[] = ['TitleSlide', 'BulletPoints', 'BigStat', 'Quote', 'CodeExplainer', 'ImageFrame'];

export const templateLabels: Record<SceneTemplate, string> = {
  TitleSlide: '标题封面',
  BulletPoints: '要点列表',
  BigStat: '数据强调',
  Quote: '引用金句',
  CodeExplainer: '代码展示',
  ImageFrame: '图文画面',
};

interface Props {
  value: SceneTemplate;
  onChange: (value: SceneTemplate) => void;
}

export default function TemplateSelector({ value, onChange }: Props) {
  return (
    <select className="select" value={value} onChange={(event) => onChange(event.target.value as SceneTemplate)}>
      {templates.map((template) => (
        <option value={template} key={template}>
          {templateLabels[template]}
        </option>
      ))}
    </select>
  );
}
