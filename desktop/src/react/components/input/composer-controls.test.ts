import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../../..');

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'm'));
  return match?.[1] || '';
}

function zIndex(block: string): number {
  const value = block.match(/z-index:\s*(\d+)/)?.[1];
  return value ? Number(value) : 0;
}

describe('composer controls regression', () => {
  it('keeps task and execution mode menus above the composer chrome', () => {
    const inputCss = read('desktop/src/react/components/input/InputArea.module.css');
    const taskCss = read('desktop/src/react/components/input/TaskModePicker.module.css');
    const securityCss = read('desktop/src/react/components/input/SecurityModeSelector.module.css');

    expect(cssBlock(inputCss, '.input-actions')).toContain('overflow: visible');
    expect(inputCss).toContain('.input-wrapper > *');
    expect(inputCss).not.toContain('.input-wrapper * {\n    min-width: 0;');
    expect(zIndex(cssBlock(taskCss, '.picker-wrap'))).toBeGreaterThanOrEqual(20);
    expect(zIndex(cssBlock(taskCss, '.panel'))).toBeGreaterThanOrEqual(10_000);
    expect(zIndex(cssBlock(securityCss, '.selector'))).toBeGreaterThanOrEqual(20);
    expect(zIndex(cssBlock(securityCss, '.dropdown'))).toBeGreaterThanOrEqual(10_000);
    expect(cssBlock(inputCss, '.thinking-selector')).toContain('flex: 0 0 auto');
    expect(cssBlock(inputCss, '.thinking-dropdown')).toContain('width: 280px');
    expect(zIndex(cssBlock(inputCss, '.thinking-dropdown'))).toBeGreaterThanOrEqual(10_000);
    expect(cssBlock(securityCss, '.dropdown')).toContain('width: 260px');
    expect(cssBlock(taskCss, '.panel')).toContain('min-width: 300px');
  });

  it('keeps the model chooser visually attached to the send button', () => {
    const submitArea = read('desktop/src/react/components/input/SubmitArea.tsx');
    const inputCss = read('desktop/src/react/components/input/InputArea.module.css');

    expect(submitArea).toContain("styles['send-controls']");
    expect(cssBlock(inputCss, '.send-controls')).toContain('display: inline-flex');
    expect(cssBlock(inputCss, '.send-controls')).toContain('gap: 0.34rem');
  });

  it('uses concise Chinese copy for deep research controls and status', () => {
    const panel = read('desktop/src/react/components/input/DeepResearchPanel.tsx');
    const inputArea = read('desktop/src/react/components/InputArea.tsx');
    const runner = read('desktop/src/react/components/input/useDeepResearchRunner.ts');
    const formatter = read('desktop/src/react/components/input/deep-research.ts');
    const serverFormatter = read('server/routes/deep-research.ts');
    const joined = [panel, inputArea, runner, formatter, serverFormatter].join('\n');

    expect(joined).toContain('深度调研');
    expect(joined).toContain('正在使用');
    expect(joined).not.toMatch(/verifier|质量地板|候选答案|winner:/);
  });

  it('keeps the deep research button as an explicit mode before running', () => {
    const inputArea = read('desktop/src/react/components/InputArea.tsx');
    const runner = read('desktop/src/react/components/input/useDeepResearchRunner.ts');
    const submitArea = read('desktop/src/react/components/input/SubmitArea.tsx');

    expect(inputArea).toContain('setDeepResearchOpen((open) => !open)');
    expect(inputArea).toContain('deepResearchOpen && text');
    expect(runner).toContain('深研已启动');
    expect(submitArea).toContain('aria-pressed={deepResearchOpen}');
  });

  it('shows a left-to-right waiting sweep while the assistant is thinking', () => {
    const chatCss = read('desktop/src/react/components/chat/Chat.module.css');
    const trace = read('desktop/src/react/components/chat/ExecutionTraceBlock.tsx');

    expect(chatCss).toContain('.typingIndicator::after');
    expect(chatCss).toContain('.executionTraceRunning::after');
    expect(chatCss).toContain('waitingSweep');
    expect(chatCss).toContain('background-size: 220% 100%');
    expect(trace).toContain('setElapsedTick');
  });
});
