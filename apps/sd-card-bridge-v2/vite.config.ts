import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
        plugins: [
                react(),
                { name: 'fcm-html-version', transformIndexHtml: (html) => html.replaceAll('__APP_VERSION__', version) },
        ],
        define: { __APP_VERSION__: JSON.stringify(version) },
	server: {
		host: '0.0.0.0',
		port: 5173,
	},
});
