import { createFirebaseSdk } from '@selarikru/inference-firebase-web';
import { app } from '../firebase.ts';
import { startBenchPage } from './page.ts';
import '../index.css';

// App Check (reCAPTCHA Enterprise) is set up inside createFirebaseSdk, as for the assistant; the debug provider exists only in dev builds.
const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
startBenchPage(createFirebaseSdk({ app, recaptchaSiteKey: siteKey || undefined }), document.getElementById('bench-status')!);
