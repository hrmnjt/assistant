import { mergeConfig } from 'vite';
import application from '../../vite.config';

// Fixture tests must never fall through to a real Node server on port 3000,
// including presence cleanup requests after Playwright removes page routes.
export default mergeConfig(application, { preview: { proxy: {} } });
