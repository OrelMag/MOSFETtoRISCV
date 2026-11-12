// Types for scripts/version.mjs (vite.config.ts imports it; desktop/build.mjs runs it as plain Node).
export declare function buildNumber(cwd: string | URL): number;
export declare function versionOf(root: string | URL): { major: number; minor: number; build: number; site: string; semver: string };
