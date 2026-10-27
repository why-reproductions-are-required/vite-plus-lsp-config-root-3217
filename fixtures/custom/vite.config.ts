import { tanstackStart } from '@tanstack/react-start/plugin/vite';
export default {
  root: 'app',
  plugins: [tanstackStart()],
  lint: { rules: { 'no-console': 'error' } },
  fmt: { semi: false },
};
