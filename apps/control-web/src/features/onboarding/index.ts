export { createOnboardingApi, type ApiResult, type InferenceChoice, type OnboardingApi, type OwnerCostLine } from './api.ts';
export const hrefForSetup = (id: string): string => `#/onboarding?id=${encodeURIComponent(id)}`;
