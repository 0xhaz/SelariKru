/** The test server's origin. PW_PORT moves it off 5174 when another app holds that port; playwright.config.ts uses the same value. */
export const PW_PORT = Number(process.env['PW_PORT'] ?? 5174);
export const ORIGIN = `http://127.0.0.1:${PW_PORT}`;
