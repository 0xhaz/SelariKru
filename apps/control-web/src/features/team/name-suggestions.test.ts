import { describe, expect, it } from 'vitest';
import { defaultSuggestion, suggestedName } from './name-suggestions.ts';

describe('name suggestions per role', () => {
  it('offers a default per role position, and none for an unknown role', () => {
    expect(defaultSuggestion(0)).toBe('Aisyah');
    expect(suggestedName(null, 'frontend', ['backend', 'frontend'])).toBe('Ravi');
    expect(suggestedName(null, 'qa', ['backend'])).toBeNull();
    expect(suggestedName(null, null)).toBeNull();
  });
});
