import { useEffect, useMemo, useState } from 'react';

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
      h('input.hintAnalyzeExcel', '帮我分析桌面上的 Excel...'),
      h('input.hintGoal', '输入 /goal 设定一个不达成不停的目标'),
      h('input.hintSlash', '输入 / 查看快捷命令'),
      h('input.hintScanStock', '扫描一下今天 A 股有什么异动...'),
      h('input.hintDrag', '拖拽文件到此处附加上下文'),
      h('input.hintOrganize', '把这个文件夹里的文档整理一下...'),
      h('input.hintAt', '输入 @ 引用文件或文件夹'),
      h('input.hintDesk', 'Cmd+J 打开任务清单'),
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
