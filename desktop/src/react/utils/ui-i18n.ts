function normalizeLocale(locale?: string): 'zh' | 'zh-TW' | 'ja' | 'ko' | 'en' {
  const value = String(locale || '').trim();
  if (value === 'zh-TW' || value === 'zh-Hant') return 'zh-TW';
  if (value.startsWith('zh')) return 'zh';
  if (value.startsWith('ja')) return 'ja';
  if (value.startsWith('ko')) return 'ko';
  return 'en';
}

function applyVars(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  let text = template;
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${key}}`, String(value));
  }
  return text;
}

const UI_FALLBACKS: Record<string, Record<string, string>> = {
  zh: {
    'status.reconnecting': '正在重连…',
    'status.disconnected': '连接已断开',
    'status.reconnect': '重新连接',
    'status.llmSlowResponse': '模型仍在处理中，请稍等片刻。',
    'status.llmStillWorking': '模型仍在处理中，已等待约 {minutes} 分钟。',
    'status.recoveringToolExecution': '模型刚才没有真正调用工具，Lynn 正在把它拉回真实执行链路。',
    'status.tasksRecovered': '已恢复 {count} 个后台任务',
    'status.tasksRecoveredRunning': '{count} 个后台任务仍在运行',
    'status.tasksRecoveredWaiting': '{count} 个后台任务仍在运行，其中 {waiting} 个仍在等待确认',
    'status.routeReasoningPlanned': '检测到分析型任务，Lynn 会优先按默认推理链路处理。',
    'status.routeExecutionPlanned': '检测到执行型任务，Lynn 会优先按默认执行链路处理。',
    'status.routeCodingPlanned': '检测到编码型任务，Lynn 会优先按默认编码链路处理。',
    'status.routeVisionPlanned': '检测到图像或附件分析任务，Lynn 会优先按默认推理链路处理。',
    'status.defaultModelSlowResponse': '默认工作模型主链路稍慢，Lynn 正在后台接力备用链路。',
    'status.defaultModelRecoveringToolExecution': '默认工作模型刚才没有真正完成工具执行，Lynn 正在切到备用执行链路继续处理。',
    'status.defaultModelStillWorking': '默认工作模型仍在处理中，已等待约 {minutes} 分钟。Lynn 会继续接力备用链路。',
    'status.defaultReasoningSlowResponse': '默认推理链路稍慢，Lynn 正在后台接力备用推理链路。',
    'status.defaultReasoningStillWorking': '默认推理链路仍在处理中，已等待约 {minutes} 分钟。Lynn 会继续接力备用推理链路。',
    'status.defaultExecutionSlowResponse': '默认执行链路稍慢，Lynn 正在后台接力备用执行链路。',
    'status.defaultExecutionStillWorking': '默认执行链路仍在处理中，已等待约 {minutes} 分钟。Lynn 会继续接力备用执行链路。',
    'status.defaultCodingSlowResponse': '默认编码链路稍慢，Lynn 正在后台接力备用编码链路。',
    'status.defaultCodingStillWorking': '默认编码链路仍在处理中，已等待约 {minutes} 分钟。Lynn 会继续接力备用编码链路。',
    'status.defaultCodingRecoveringToolExecution': '默认编码链路刚才没有真正完成工具执行，Lynn 正在切到备用编码链路继续处理。',
  },
  'zh-TW': {
    'status.reconnecting': '正在重新連線…',
    'status.disconnected': '連線已中斷',
    'status.reconnect': '重新連線',
    'status.llmSlowResponse': '模型仍在處理中，請稍候。',
    'status.llmStillWorking': '模型仍在處理中，已等待約 {minutes} 分鐘。',
    'status.recoveringToolExecution': '模型剛才沒有真正呼叫工具，Lynn 正在把它拉回真實執行鏈路。',
    'status.tasksRecovered': '已恢復 {count} 個背景任務',
    'status.tasksRecoveredRunning': '{count} 個背景任務仍在執行',
    'status.tasksRecoveredWaiting': '{count} 個背景任務仍在執行，其中 {waiting} 個仍在等待確認',
    'status.routeReasoningPlanned': '偵測到分析型任務，Lynn 會優先按預設推理鏈路處理。',
    'status.routeExecutionPlanned': '偵測到執行型任務，Lynn 會優先按預設執行鏈路處理。',
    'status.routeCodingPlanned': '偵測到編碼型任務，Lynn 會優先按預設編碼鏈路處理。',
    'status.routeVisionPlanned': '偵測到圖像或附件分析任務，Lynn 會優先按預設推理鏈路處理。',
    'status.defaultModelSlowResponse': '預設工作模型主鏈路稍慢，Lynn 正在背景接力備援鏈路。',
    'status.defaultModelRecoveringToolExecution': '預設工作模型剛才沒有真正完成工具執行，Lynn 正在切到備援執行鏈路繼續處理。',
    'status.defaultModelStillWorking': '預設工作模型仍在處理中，已等待約 {minutes} 分鐘。Lynn 會持續接力備援鏈路。',
    'status.defaultReasoningSlowResponse': '預設推理鏈路稍慢，Lynn 正在背景接力備援推理鏈路。',
    'status.defaultReasoningStillWorking': '預設推理鏈路仍在處理中，已等待約 {minutes} 分鐘。Lynn 會持續接力備援推理鏈路。',
    'status.defaultExecutionSlowResponse': '預設執行鏈路稍慢，Lynn 正在背景接力備援執行鏈路。',
    'status.defaultExecutionStillWorking': '預設執行鏈路仍在處理中，已等待約 {minutes} 分鐘。Lynn 會持續接力備援執行鏈路。',
    'status.defaultCodingSlowResponse': '預設編碼鏈路稍慢，Lynn 正在背景接力備援編碼鏈路。',
    'status.defaultCodingStillWorking': '預設編碼鏈路仍在處理中，已等待約 {minutes} 分鐘。Lynn 會持續接力備援編碼鏈路。',
    'status.defaultCodingRecoveringToolExecution': '預設編碼鏈路剛才沒有真正完成工具執行，Lynn 正在切到備援編碼鏈路繼續處理。',
  },
  ja: {
    'status.reconnecting': '再接続しています…',
    'status.disconnected': '接続が切断されました',
    'status.reconnect': '再接続',
    'status.llmSlowResponse': 'モデルはまだ処理中です。もう少しお待ちください。',
    'status.llmStillWorking': 'モデルはまだ処理中です。約 {minutes} 分待っています。',
    'status.recoveringToolExecution': 'モデルが実際のツール呼び出しを完了しなかったため、Lynn が本来の実行経路へ戻しています。',
    'status.tasksRecovered': 'バックグラウンドタスクを {count} 件復元しました',
    'status.tasksRecoveredRunning': 'バックグラウンドタスクが {count} 件まだ実行中です',
    'status.tasksRecoveredWaiting': 'バックグラウンドタスクが {count} 件まだ実行中で、そのうち {waiting} 件は承認待ちです',
    'status.routeReasoningPlanned': '分析系のタスクを検出しました。Lynn はこのターンで既定の推論ルートを優先します。',
    'status.routeExecutionPlanned': '実行系のタスクを検出しました。Lynn はこのターンで既定の実行ルートを優先します。',
    'status.routeCodingPlanned': 'コーディング系のタスクを検出しました。Lynn はこのターンで既定のコーディングルートを優先します。',
    'status.routeVisionPlanned': '画像または添付ファイルの解析タスクを検出しました。Lynn はこのターンで既定の推論ルートを優先します。',
    'status.defaultModelSlowResponse': '既定の作業モデルの主経路が少し遅いため、Lynn がバックグラウンドで予備経路へ引き継いでいます。',
    'status.defaultModelRecoveringToolExecution': '既定の作業モデルは実際のツール実行を完了できなかったため、Lynn がこのターンを予備の実行ルートへ切り替えています。',
    'status.defaultModelStillWorking': '既定の作業モデルはまだ処理中です。約 {minutes} 分待っています。Lynn は引き続き予備経路へ引き継ぎながら処理します。',
    'status.defaultReasoningSlowResponse': '既定の推論ルートが少し遅いため、Lynn がバックグラウンドで予備の推論ルートへ引き継いでいます。',
    'status.defaultReasoningStillWorking': '既定の推論ルートはまだ処理中です。約 {minutes} 分待っています。Lynn は引き続き予備の推論ルートへ引き継ぎながら処理します。',
    'status.defaultExecutionSlowResponse': '既定の実行ルートが少し遅いため、Lynn がバックグラウンドで予備の実行ルートへ引き継いでいます。',
    'status.defaultExecutionStillWorking': '既定の実行ルートはまだ処理中です。約 {minutes} 分待っています。Lynn は引き続き予備の実行ルートへ引き継ぎながら処理します。',
    'status.defaultCodingSlowResponse': '既定のコーディングルートが少し遅いため、Lynn がバックグラウンドで予備のコーディングルートへ引き継いでいます。',
    'status.defaultCodingStillWorking': '既定のコーディングルートはまだ処理中です。約 {minutes} 分待っています。Lynn は引き続き予備のコーディングルートへ引き継ぎながら処理します。',
    'status.defaultCodingRecoveringToolExecution': '既定のコーディングルートは実際のツール実行を完了できなかったため、Lynn がこのターンを予備のコーディングルートへ切り替えています。',
  },
  ko: {
    'status.reconnecting': '다시 연결하는 중…',
    'status.disconnected': '연결이 끊겼어요',
    'status.reconnect': '다시 연결',
    'status.llmSlowResponse': '모델이 아직 처리 중입니다. 잠시만 기다려 주세요.',
    'status.llmStillWorking': '모델이 아직 처리 중입니다. 약 {minutes}분째 기다리고 있어요.',
    'status.recoveringToolExecution': '모델이 실제 도구 호출을 끝내지 못해 Lynn이 올바른 실행 경로로 되돌리고 있어요.',
    'status.tasksRecovered': '백그라운드 작업 {count}개를 복구했어요',
    'status.tasksRecoveredRunning': '백그라운드 작업 {count}개가 아직 실행 중이에요',
    'status.tasksRecoveredWaiting': '백그라운드 작업 {count}개가 아직 실행 중이며, 그중 {waiting}개는 승인을 기다리고 있어요',
    'status.routeReasoningPlanned': '분석형 작업이 감지되어 Lynn이 이번 턴에서 기본 추론 경로를 우선 사용합니다.',
    'status.routeExecutionPlanned': '실행형 작업이 감지되어 Lynn이 이번 턴에서 기본 실행 경로를 우선 사용합니다.',
    'status.routeCodingPlanned': '코딩 작업이 감지되어 Lynn이 이번 턴에서 기본 코딩 경로를 우선 사용합니다.',
    'status.routeVisionPlanned': '이미지 또는 첨부 분석 작업이 감지되어 Lynn이 이번 턴에서 기본 추론 경로를 우선 사용합니다.',
    'status.defaultModelSlowResponse': '기본 작업 모델의 주 경로가 조금 느립니다. Lynn이 백그라운드에서 보조 경로로 넘겨 처리하고 있어요.',
    'status.defaultModelRecoveringToolExecution': '기본 작업 모델이 실제 도구 실행을 끝내지 못해 Lynn이 이번 턴을 보조 실행 경로로 넘기고 있어요.',
    'status.defaultModelStillWorking': '기본 작업 모델이 아직 처리 중입니다. 약 {minutes}분째 기다리는 중이며 Lynn이 계속 보조 경로로 넘겨 처리하고 있어요.',
    'status.defaultReasoningSlowResponse': '기본 추론 경로가 조금 느립니다. Lynn이 백그라운드에서 보조 추론 경로로 넘겨 처리하고 있어요.',
    'status.defaultReasoningStillWorking': '기본 추론 경로가 아직 처리 중입니다. 약 {minutes}분째 기다리는 중이며 Lynn이 계속 보조 추론 경로로 넘겨 처리하고 있어요.',
    'status.defaultExecutionSlowResponse': '기본 실행 경로가 조금 느립니다. Lynn이 백그라운드에서 보조 실행 경로로 넘겨 처리하고 있어요.',
    'status.defaultExecutionStillWorking': '기본 실행 경로가 아직 처리 중입니다. 약 {minutes}분째 기다리는 중이며 Lynn이 계속 보조 실행 경로로 넘겨 처리하고 있어요.',
    'status.defaultCodingSlowResponse': '기본 코딩 경로가 조금 느립니다. Lynn이 백그라운드에서 보조 코딩 경로로 넘겨 처리하고 있어요.',
    'status.defaultCodingStillWorking': '기본 코딩 경로가 아직 처리 중입니다. 약 {minutes}분째 기다리는 중이며 Lynn이 계속 보조 코딩 경로로 넘겨 처리하고 있어요.',
    'status.defaultCodingRecoveringToolExecution': '기본 코딩 경로가 실제 도구 실행을 끝내지 못해 Lynn이 이번 턴을 보조 코딩 경로로 넘기고 있어요.',
  },
  en: {
    'status.reconnecting': 'Reconnecting…',
    'status.disconnected': 'Connection lost',
    'status.reconnect': 'Reconnect',
    'status.llmSlowResponse': 'The model is still working. Please wait a moment.',
    'status.llmStillWorking': 'The model is still working. Waited about {minutes} minute(s).',
    'status.recoveringToolExecution': 'The model did not complete a real tool call. Lynn is steering the turn back onto the real execution path.',
    'status.tasksRecovered': 'Recovered {count} background task(s)',
    'status.tasksRecoveredRunning': '{count} background task(s) are still running',
    'status.tasksRecoveredWaiting': '{count} background task(s) are still running, with {waiting} waiting for approval',
    'status.routeReasoningPlanned': 'Detected an analysis task. Lynn will prioritize the default reasoning route for this turn.',
    'status.routeExecutionPlanned': 'Detected an execution task. Lynn will prioritize the default execution route for this turn.',
    'status.routeCodingPlanned': 'Detected a coding task. Lynn will prioritize the default coding route for this turn.',
    'status.routeVisionPlanned': 'Detected an image or attachment analysis task. Lynn will prioritize the default reasoning route for this turn.',
    'status.defaultModelSlowResponse': 'The default work model primary route is a bit slow. Lynn is relaying this turn through backup routes in the background.',
    'status.defaultModelRecoveringToolExecution': 'The default work model did not complete real tool execution just now. Lynn is moving this turn onto a backup execution route.',
    'status.defaultModelStillWorking': 'The default work model is still working. Waited about {minutes} minute(s). Lynn will keep relaying this turn through backup routes.',
    'status.defaultReasoningSlowResponse': 'The default reasoning route is a bit slow. Lynn is relaying this turn through backup reasoning routes in the background.',
    'status.defaultReasoningStillWorking': 'The default reasoning route is still working. Waited about {minutes} minute(s). Lynn will keep relaying this turn through backup reasoning routes.',
    'status.defaultExecutionSlowResponse': 'The default execution route is a bit slow. Lynn is relaying this turn through backup execution routes in the background.',
    'status.defaultExecutionStillWorking': 'The default execution route is still working. Waited about {minutes} minute(s). Lynn will keep relaying this turn through backup execution routes.',
    'status.defaultCodingSlowResponse': 'The default coding route is a bit slow. Lynn is relaying this turn through backup coding routes in the background.',
    'status.defaultCodingStillWorking': 'The default coding route is still working. Waited about {minutes} minute(s). Lynn will keep relaying this turn through backup coding routes.',
    'status.defaultCodingRecoveringToolExecution': 'The default coding route did not complete real tool execution just now. Lynn is moving this turn onto a backup coding route.',
  },
};

export function looksLikeI18nKey(value: string): boolean {
  return /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(String(value || '').trim());
}

export function resolveUiI18nText(raw: unknown, vars?: Record<string, string | number>): string {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (!looksLikeI18nKey(text)) return text;

  const translated = typeof window !== 'undefined' && typeof window.t === 'function'
    ? window.t(text, vars)
    : text;
  if (translated && translated !== text) return String(translated);

  const locale = normalizeLocale(typeof window !== 'undefined' ? window.i18n?.locale : 'zh');
  const fallback = UI_FALLBACKS[locale]?.[text];
  return fallback ? applyVars(fallback, vars) : text;
}
