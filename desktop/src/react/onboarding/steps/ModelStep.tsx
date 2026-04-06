/**
 * ModelStep.tsx — Step 3: Model selection
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { loadModels as loadModelsAction, saveModel as saveModelAction } from '../onboarding-actions';
import type { OnboardingFetch } from '../onboarding-actions';
import { StepContainer } from '../onboarding-ui';

interface ModelStepProps {
  preview: boolean;
  onboardingFetch: OnboardingFetch;
  providerName: string;
  providerUrl: string;
  providerApi: string;
  apiKey: string;
  goToStep: (index: number) => void;
  showError: (msg: string) => void;
}

export function ModelStep({
  preview, onboardingFetch, providerName, providerUrl, providerApi, apiKey,
  goToStep, showError,
}: ModelStepProps) {
  const [fetchedModels, setFetchedModels] = useState<{ id: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [modelLoading, setModelLoading] = useState('');
  const [modelError, setModelError] = useState(false);

  const modelsLoadedFor = useRef('');

  // ── Load models ──
  const loadModels = useCallback(async () => {
    if (preview) {
      setFetchedModels([{ id: 'model-a' }, { id: 'model-b' }, { id: 'model-c' }]);
      setModelLoading('');
      return;
    }

    setModelLoading(t('onboarding.model.loading'));
    setModelError(false);
    try {
      const result = await loadModelsAction({ onboardingFetch, providerName, providerUrl, providerApi, apiKey });
      if (result.error) {
        setModelLoading(result.error);
        setModelError(true);
        return;
      }
      setFetchedModels(result.models);
      setSelectedModel('');
      modelsLoadedFor.current = providerName;
      setModelLoading('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setModelLoading(msg);
      setModelError(true);
    }
  }, [preview, onboardingFetch, providerName, providerUrl, providerApi, apiKey]);

  useEffect(() => {
    if (modelsLoadedFor.current === providerName) return;
    loadModels();
  }, [providerName, loadModels]);

  // ── Filtered models ──
  const filteredModels = modelSearch
    ? fetchedModels.filter(m => m.id.toLowerCase().includes(modelSearch.toLowerCase()))
    : fetchedModels;

  // ── Next ──
  const onNext = useCallback(async () => {
    if (preview) { goToStep(4); return; }
    if (!selectedModel) return;
    try {
      await saveModelAction({
        onboardingFetch, selectedModel, fetchedModels, providerName,
      });
      goToStep(4);
    } catch (err) {
      console.error('[onboarding] save model failed:', err);
      showError(t('onboarding.error'));
    }
  }, [preview, selectedModel, onboardingFetch, fetchedModels, providerName, goToStep, showError]);

  return (
    <StepContainer>
      <h1 className="onboarding-title">{t('onboarding.model.title')}</h1>
      <p className="onboarding-subtitle">{t('onboarding.model.subtitle')}</p>

      <input
        className="ob-input ob-model-search"
        type="text"
        placeholder={t('onboarding.model.searchPlaceholder')}
        value={modelSearch}
        onChange={e => setModelSearch(e.target.value)}
        autoComplete="off"
      />

      <div className="model-list">
        {modelLoading ? (
          <div className="model-empty">
            {modelLoading}
            {modelError && (
              <button
                className="ob-btn ob-btn-secondary"
                style={{ marginTop: 8, fontSize: '0.8rem' }}
                onClick={() => { modelsLoadedFor.current = ''; loadModels(); }}
              >
                {t('onboarding.model.retry') || '重试'}
              </button>
            )}
          </div>
        ) : filteredModels.length === 0 ? (
          <div className="model-empty">{t('onboarding.model.empty')}</div>
        ) : (
          filteredModels.map(model => (
            <div
              key={model.id}
              className={`model-item${selectedModel === model.id ? ' selected' : ''}`}
              onClick={() => setSelectedModel(model.id)}
            >
              {model.id}
            </div>
          ))
        )}
      </div>

      <p className="ob-settings-hint">{t('onboarding.model.settingsHint')}</p>

      <div className="onboarding-actions">
        <button className="ob-btn ob-btn-secondary" onClick={() => goToStep(2)}>
          {t('onboarding.model.back')}
        </button>
        <button
          className="ob-btn ob-btn-primary"
          disabled={!preview && !selectedModel}
          onClick={onNext}
        >
          {t('onboarding.model.next')}
        </button>
      </div>
    </StepContainer>
  );
}
