import { onAuthStateChanged } from 'firebase/auth';
import { createFirebaseSdk } from '@selarikru/inference-firebase-web';
import { app, auth } from '../firebase.ts';
import { startBenchPage } from './page.ts';
import '../index.css';

// App Check (reCAPTCHA Enterprise) is set up inside createFirebaseSdk, as for the assistant; the debug provider exists only in dev builds.
const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;
const status = document.getElementById('bench-status')!;
let started = false;
// The owner signs in through the control web on this origin; the bridge waits for that session.
onAuthStateChanged(auth, (user) => {
  if (started) return;
  started = startBenchPage(createFirebaseSdk({ app, recaptchaSiteKey: siteKey || undefined }), status, user !== null) !== null;
});
