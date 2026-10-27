import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.{ts,tsx}'],
		// UI tests drive several real child processes; under a full parallel run they need headroom.
		testTimeout: 45_000,
	},
});
