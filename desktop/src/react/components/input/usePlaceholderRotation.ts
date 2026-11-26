import { useEffect, useMemo, useState } from 'react';
import { isChineseLocale } from '../../utils/locale';

/** Inline zh/en picker for the rotating composer placeholders. */
const D = (zh: string, en: string) => (isChineseLocale() ? zh : en);

type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface UsePlaceholderRotationArgs {
  agentYuan: string;
  inputValue: string;
  t: Translate;
  textareaFocused: boolean;
}

export function usePlaceholderRotation({
  agentYuan,
  inputValue,
  t,
  textareaFocused,
}: UsePlaceholderRotationArgs) {
  const placeholderHints = useMemo(() => {
    const yuanPh = t(`yuan.placeholder.${agentYuan}`);
    const base = (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
    const h = (key: string, fallback: string) => {
      const v = t(key);
      return (v && v !== key && !v.startsWith('input.hint')) ? v : fallback;
    };
    return [
      base,
      h('input.hintAnalyzeExcel', D('帮我分析桌面上的 Excel...', 'Analyze the spreadsheet on my desktop…')),
      h('input.hintGoal', D('输入 /goal 设定一个不达成不停的目标', 'Type /goal to set a goal Lynn keeps pursuing until it is met')),
      h('input.hintSlash', D('输入 / 查看快捷命令', 'Type / to see quick commands')),
      h('input.hintScanStock', D('扫描一下今天 A 股有什么异动...', "Scan today's market for unusual moves…")),
      h('input.hintDrag', D('拖拽文件到此处附加上下文', 'Drag files here to add context')),
      h('input.hintOrganize', D('把这个文件夹里的文档整理一下...', 'Organize the documents in this folder…')),
      h('input.hintAt', D('输入 @ 引用文件或文件夹', 'Type @ to reference a file or folder')),
      h('input.hintDesk', D('Cmd+J 打开任务清单', 'Cmd+J opens the task list')),
    ];
  }, [agentYuan, t]);

  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (inputValue.trim() || textareaFocused) return;
    const timer = setInterval(() => setIndex(i => (i + 1) % placeholderHints.length), 6000);
    return () => clearInterval(timer);
  }, [inputValue, placeholderHints.length, textareaFocused]);

  return placeholderHints[index] || placeholderHints[0];
}
