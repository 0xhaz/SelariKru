import type { ModelCatalogView } from '@selarikru/view-protocol';

/**
 * H9 fix round 1 (H1): the demo with coding workers on. Only dev `?demo&codingWorkers=claude_code` and tests pass this to the mock (MockOptions.codingWorkers);
 * the hackathon build, the demo by default and the hosted demo never show it. Claude only: no provider is listed that is not installed. Opus is marked not
 * allowed so the demo can show a refused choice.
 */
export const CLAUDE_DEMO: { readonly catalog: ModelCatalogView; readonly assignment: { readonly provider: string; readonly model: string } } = {
  catalog: {
    status: 'detected', detail: null, projectDefault: { provider: 'anthropic', model: 'claude-sonnet-5-5' }, codingWorkers: 'claude_code',
    providers: [{
      provider: 'anthropic', label: 'Claude', harnessVersion: '2.1.316',
      models: [
        { modelId: 'claude-sonnet-5-5', label: 'Sonnet 5.5', route: 'cloud', allowedByPolicy: true, policyReason: null },
        { modelId: 'claude-haiku-5-5', label: 'Haiku 5.5', route: 'cloud', allowedByPolicy: true, policyReason: null },
        { modelId: 'claude-opus-5-5', label: 'Opus 5.5', route: 'cloud', allowedByPolicy: false, policyReason: 'model_not_allowed' },
      ],
    }],
  },
  assignment: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
};
