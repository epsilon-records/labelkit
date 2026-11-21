import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	forbidOnly: Boolean(process.env.CI),
	reporter: 'list',
	use: {
		baseURL: 'http://127.0.0.1:4173',
		trace: 'retain-on-failure'
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: '**/*.mobile.spec.ts' },
		{
			name: 'mobile-webkit',
			use: { ...devices['iPhone 15'], browserName: 'webkit' },
			testMatch: '**/*.mobile.spec.ts'
		}
	],
	webServer: {
		command: 'pnpm build && pnpm preview --host 127.0.0.1 --port 4173 --strictPort',
		url: 'http://127.0.0.1:4173/login',
		reuseExistingServer: false,
		timeout: 180_000,
		// Public signed-out pages need no database or real Supabase credentials.
		env: {
			DATABASE_URL: 'postgresql://localhost:1/unused',
			PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
			PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'ci'
		}
	}
});
