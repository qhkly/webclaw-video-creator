import { useVideoConfig } from 'remotion';
import { DESIGN_BASE_WIDTH } from '../../src/constants/aspect';

export function useScale() {
  const { width } = useVideoConfig();
  return width / DESIGN_BASE_WIDTH;
}
