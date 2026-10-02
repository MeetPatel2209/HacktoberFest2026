import { defineConfig } from 'vite';

// Pin a timezone with a late-October DST change so the DST tests are deterministic
// on any machine. Set before workers spawn so they inherit it.
process.env.TZ = 'Europe/Berlin';

export default defineConfig({
  // Relative base so the build works from a GitHub Pages project subpath.
  base: './',
  test: {
    include: ['tests/**/*.test.js'],
  },
});
