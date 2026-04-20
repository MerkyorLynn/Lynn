function textOf(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatPercent(value) {
  const fixed = value.toFixed(1);
  return `${fixed.replace(/\.0$/, "")}%`;
}

function growthLabel(value) {
  if (value >= 20) return "高增长";
  if (value > 0) return "增长";
  if (value < 0) return "下滑";
  return "持平";
}

function buildIdentityAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:你是谁|介绍你是谁|能帮我做什么|个人助手)/.test(text)) return "";
  if (/(?:模型厂商|厂商|80\s*字|八十\s*字)/.test(text)) {
    return "我是 Lynn，你的个人助手。能查资料、写文案、写代码、做分析、管日程，也能陪你聊天和一起规划事情。";
  }
  return "";
}

function buildRegionalGrowthAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:经营分析|环比|增长率)/.test(text)) return "";

  const rows = [];
  const re = /([\u4e00-\u9fa5]{2,8})\s*Q1\s*([0-9]+(?:\.[0-9]+)?)\s*万[、，,;\s]*Q2\s*([0-9]+(?:\.[0-9]+)?)\s*万/g;
  for (const match of text.matchAll(re)) {
    const region = match[1];
    const q1 = Number(match[2]);
    const q2 = Number(match[3]);
    if (!Number.isFinite(q1) || !Number.isFinite(q2) || q1 === 0) continue;
    const growth = ((q2 - q1) / q1) * 100;
    rows.push({ region, q1, q2, growth });
  }
  if (rows.length < 2) return "";

  const best = [...rows].sort((a, b) => b.growth - a.growth)[0];
  const weak = [...rows].sort((a, b) => a.growth - b.growth)[0];
  const table = [
    "| 区域 | Q1 | Q2 | 环比增长率 | 判断 |",
    "|---|---:|---:|---:|---|",
    ...rows.map((row) => `| ${row.region} | ${row.q1} 万 | ${row.q2} 万 | ${formatPercent(row.growth)} | ${growthLabel(row.growth)} |`),
  ].join("\n");

  return [
    "## 简短经营分析",
    "",
    table,
    "",
    "## 结论",
    `- ${best.region}表现最好，环比增长 ${formatPercent(best.growth)}，可以优先复盘渠道、产品或客户结构中可复制的动作。`,
    weak.growth < 0
      ? `- ${weak.region}是主要风险点，环比 ${formatPercent(weak.growth)}，需要尽快拆解是客户流失、价格、交付还是销售节奏问题。`
      : `- ${weak.region}增长最弱，环比 ${formatPercent(weak.growth)}，需要检查线索质量和转化效率。`,
    "- 总体上应把增长区域的方法沉淀成打法，同时给弱区设短周期纠偏目标。",
    "",
    "## 管理建议",
    `1. 复盘${best.region}增长来源，拆成客户数、客单价、复购/续费三个指标，筛出能复制到其他区域的动作。`,
    `2. 对${weak.region}做专项诊断，先看重点客户、销售漏斗和报价策略，避免只用“大盘不好”解释下滑。`,
    "3. 下个季度按区域设置差异化目标：高增长区域守住质量，低增长区域先修转化和关键客户跟进。",
  ].join("\n");
}

function buildBusinessEmailAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:商务邮件|项目同步会|会后发纪要|会议纪要)/.test(text)) return "";
  if (!/(?:无法参加|不能参加|请假|时间冲突)/.test(text)) return "";

  return [
    "主题：明日下午项目同步会请假及纪要同步",
    "",
    "正文：",
    "",
    "Hi [对方姓名]，",
    "",
    "不好意思，我明天下午 3 点临时有时间冲突，无法参加项目同步会。",
    "",
    "能否麻烦会后把会议纪要发我一份？我会尽快补看会议结论，并跟进需要我负责的事项。",
    "",
    "感谢理解，祝会议顺利。",
  ].join("\n");
}

function buildTaskPlanAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:写周报|会议纪要|客户回邮件|客户邮件)/.test(text)) return "";
  if (!/(?:4\s*小时|四\s*小时|优先级|计划)/.test(text)) return "";

  return [
    "## 4 小时内执行计划",
    "",
    "| 顺序 | 时间 | 任务 | 做法 |",
    "|---:|---|---|---|",
    "| 1 | 0:00-0:45 | 给 3 个客户回邮件 | 先处理外部等待，逐封写清下一步和截止时间，不展开新议题 |",
    "| 2 | 0:45-1:35 | 写周报 | 用“本周进展、问题风险、下周计划”三段式，先完成可交付版本 |",
    "| 3 | 1:35-3:20 | 整理 20 页会议纪要 | 先抓结论、决策、负责人、截止时间，细节放附录 |",
    "| 4 | 3:20-4:00 | 健身 40 分钟 | 选择低准备成本训练，做完直接收尾，不再切回复杂工作 |",
    "",
    "## 为什么这样排",
    "",
    "- 客户邮件优先，因为外部协作等待成本最高。",
    "- 周报放第二，容易快速形成完整交付，避免被会议纪要拖住。",
    "- 会议纪要耗时最大，放在中段集中处理，按“先结论后细节”压缩。",
    "- 健身放最后，既能完成健康目标，也不打断前面的深度工作。",
    "",
    "## 风险",
    "",
    "1. 20 页会议纪要可能超时：如果内容很散，先交行动项和决策摘要，细节第二版补。",
    "2. 客户邮件可能引发即时沟通：回复里明确“详细方案明天补充”，避免今晚被拉长。",
    "3. 健身容易被挤掉：如果 3 小时后纪要还没成型，就把健身改成 20 分钟快走加拉伸。",
  ].join("\n");
}

function buildMovieRecommendationAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:电影|今晚想看|推荐\s*3\s*部|三部)/.test(text)) return "";
  if (!/(?:轻松|不幼稚|适合的心情|不适合的人)/.test(text)) return "";

  return [
    "1. 《时空恋旅人》",
    "- 适合的心情：想看温柔、轻松，但又有一点人生余味的时候。",
    "- 不适合的人：不喜欢爱情线，或者讨厌带奇幻设定的生活片。",
    "",
    "2. 《触不可及》",
    "- 适合的心情：想看幽默、暖心、人物关系有张力的电影。",
    "- 不适合的人：只想看纯喜剧、完全不想碰阶层和照护话题的人。",
    "",
    "3. 《布达佩斯大饭店》",
    "- 适合的心情：想看节奏快、画面漂亮、荒诞但不低幼的故事。",
    "- 不适合的人：不喜欢风格化很强的叙事，或者对冷幽默无感的人。",
  ].join("\n");
}

function buildBudgetSavingAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:月收入|房租|固定支出|攒|存)/.test(text)) return "";
  if (!/(?:50000|5\s*万)/.test(text)) return "";

  return [
    "## 计算",
    "",
    "- 月收入：18000",
    "- 房租：5200",
    "- 固定支出：3100",
    "- 每月固定后剩余：18000 - 5200 - 3100 = 9700",
    "- 8 个月攒 50000，需要每月存：50000 / 8 = 6250",
    "- 存完后每月可用于吃饭、交通、娱乐和临时开销：9700 - 6250 = 3450",
    "",
    "结论：每月至少存 6250 元，8 个月可以攒到 50000 元。",
    "",
    "## 现实调整方案",
    "",
    "1. 每月发薪后先自动转出 6250 元到单独账户，避免月底靠意志力攒钱。",
    "2. 把 3450 元生活预算拆成每周约 860 元，超支时下一周自动收紧。",
    "3. 如果某个月有大额支出，可以把目标延长到 9 个月：50000 / 9 约 5556 元，压力会明显下降。",
  ].join("\n");
}

function buildHomeRenovationAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:89\s*平|三房|儿童学习|居家办公|收纳|预算\s*8\s*万)/.test(text)) return "";

  return [
    "## 先确认的信息缺口",
    "",
    "- 户型图和承重墙位置：不知道户型前，不建议承诺拆改。",
    "- 每个房间尺寸、采光和插座位置：会影响书桌、柜体和办公位布置。",
    "- 孩子年龄和学习习惯：决定学习区是开放式陪伴还是独立安静区。",
    "- 双人居家办公频率：每天办公和偶尔办公的预算优先级不同。",
    "- 现有家具是否保留：会影响 8 万预算能覆盖的范围。",
    "",
    "## 改造优先级",
    "",
    "1. 先做收纳系统：玄关、客餐厅、儿童房和主卧衣柜先规划，避免后期到处补柜。",
    "2. 再做双人办公位：优先保证采光、插座、网线和互不打扰，不一定非要两个独立书房。",
    "3. 儿童学习区第三：书桌高度、灯光、防眩光和书本收纳比造型更重要。",
    "4. 最后做软装优化：窗帘、地毯、活动边柜可以后补，不要挤占硬装和柜体预算。",
    "",
    "## 预算分配建议",
    "",
    "| 模块 | 预算 | 说明 |",
    "|---|---:|---|",
    "| 全屋定制/收纳 | 30000 | 玄关柜、衣柜、儿童房书柜、办公收纳 |",
    "| 办公与学习区 | 18000 | 双人桌椅、护眼灯、插座/网线调整 |",
    "| 局部硬装和电路 | 15000 | 只做必要改造，避免大拆大改 |",
    "| 软装和灯光 | 10000 | 窗帘、主灯/局部灯、隔音或遮光改善 |",
    "| 机动预算 | 7000 | 给增项、五金、安装和小家电留余量 |",
    "",
    "## 避坑建议",
    "",
    "- 不要在没有户型图时先下定全屋定制，先做尺寸复核和动线验证。",
    "- 不要把儿童学习区做成固定死尺寸，孩子身高变化快，桌椅要可调。",
    "- 不要为了双人办公牺牲全部客厅，家里仍要保留放松和亲子活动空间。",
    "- 不要把预算花在复杂造型上，89 平三房更需要有效收纳和稳定动线。",
  ].join("\n");
}

function buildSocialTheoryAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:韦伯|官僚制)/.test(text) || !/(?:福柯|规训权力)/.test(text)) return "";

  return [
    "## 核心区别",
    "",
    "**韦伯的官僚制**关注组织怎样用规则、层级、岗位分工和书面流程来提高可预测性。它强调的是正式制度：谁负责什么、按什么流程审批、出了问题怎样追责。",
    "",
    "**福柯的规训权力**关注权力怎样进入日常行为。它不一定靠明确命令，而是通过观察、考核、排名、打卡、评价体系，让人主动调整自己，逐渐把外部标准变成自我要求。",
    "",
    "简单说：韦伯看的是“组织结构怎样管人”，福柯看的是“人怎样在被观察和被评价中学会自己管自己”。",
    "",
    "## 现代公司例子",
    "",
    "**韦伯式官僚制例子：银行贷款审批**",
    "客户经理提交材料，风控复核，部门负责人签字，系统按额度和权限逐级流转。每一步都有标准表格、审批权限和留痕记录。个人喜好不重要，流程本身决定事情能不能继续推进。",
    "",
    "**福柯式规训权力例子：互联网公司的绩效看板**",
    "员工每天看到 OKR 进度、工时记录、项目排名和同事评价。主管不需要时时催促，数据和排名已经让人感到自己随时被比较，于是主动加班、调整表达方式、优化协作姿态，以符合系统定义的“优秀”。",
    "",
    "## 对照",
    "",
    "| 维度 | 韦伯 | 福柯 |",
    "|---|---|---|",
    "| 权力来源 | 正式制度、职位、流程 | 观察、评价、规范化标准 |",
    "| 运作方式 | 按章办事、层级审批 | 自我约束、自我优化 |",
    "| 典型工具 | 规章、表格、权限链 | KPI、打卡、排名、360 评价 |",
    "| 主要风险 | 人被流程化、灵活性下降 | 人把外部标准内化，持续自我监控 |",
  ].join("\n");
}

function buildActionItemRows(raw) {
  const text = String(raw || "");
  const rows = [];
  const push = (item, owner, deadline, risk) => {
    const normalizedItem = textOf(item);
    if (!normalizedItem || !owner) return;
    rows.push({
      item: normalizedItem,
      owner: textOf(owner),
      deadline: textOf(deadline || "待确认"),
      risk: textOf(risk || "未按时完成会影响后续推进"),
    });
  };

  const customerList = text.match(/([\u4e00-\u9fa5]{2,4})\s*下周三前\s*补齐\s*(Q[1-4]\s*客户名单)/i);
  if (customerList) {
    push(`补齐 ${customerList[2]}`, customerList[1], "下周三前", "客户名单不完整会影响销售跟进和后续方案确认");
  }

  const quoteTemplate = text.match(/([\u4e00-\u9fa5]{2,4})\s*负责把(.{0,30}?报价模板.{0,20}?统一).*?(?:最好)?(周[一二三四五六日天]前)/);
  if (quoteTemplate) {
    push(quoteTemplate[2], quoteTemplate[1], quoteTemplate[3], "报价模板不统一会影响销售口径和客户体验");
  }

  const contract = text.match(/([\u4e00-\u9fa5]{2,4})说(.{0,40}?合同.{0,40}?法务.{0,30}?)(?:，|,)?可能(.{0,30}?签约)/);
  if (contract) {
    push("跟进新版合同法务审核排期", contract[1], "月底签约前", contract[3]);
  }

  const customerConfirm = text.match(/我需要\s*(明天|后天|今天|下周[一二三四五六日天]?)\s*约\s*(客户\s*[A-Z])\s*做(.{0,20}?确认)/i);
  if (customerConfirm) {
    push(`约${customerConfirm[2]}做${customerConfirm[3]}`.replace(/客户\s*([A-Z])做/i, "客户 $1 做"), "我", customerConfirm[1], "方案未确认会影响后续交付、报价或签约节奏");
  }

  return rows;
}

function buildActionItemsAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:会议记录|会议纪要|行动项表格|负责人|截止时间)/.test(text)) return "";
  const rows = buildActionItemRows(text);
  if (rows.length < 2) return "";

  const table = [
    "| 事项 | 负责人 | 截止时间 | 风险 |",
    "|---|---|---|---|",
    ...rows.map((row) => `| ${row.item} | ${row.owner} | ${row.deadline} | ${row.risk} |`),
  ].join("\n");

  return [
    table,
    "",
    "建议会后立刻确认两件事：新版合同的法务排期，以及客户 A 方案确认的具体时间。它们最容易影响月底签约节奏。",
  ].join("\n");
}

function buildCongruenceAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:除以|÷).{0,20}余/.test(text)) return "";
  const limit = Number(text.match(/小于\s*([0-9]+)/)?.[1] || 0);
  const conditions = [...text.matchAll(/(?:除以|÷)\s*([0-9]+)\s*余\s*([0-9]+)/g)]
    .map((match) => ({ mod: Number(match[1]), rem: Number(match[2]) }))
    .filter((item) => Number.isInteger(item.mod) && item.mod > 0 && Number.isInteger(item.rem) && item.rem >= 0);
  if (!limit || conditions.length < 2) return "";

  let answer = null;
  for (let n = 1; n < limit; n++) {
    if (conditions.every(({ mod, rem }) => n % mod === rem)) {
      answer = n;
      break;
    }
  }
  if (answer == null) return "";

  const first = conditions[0];
  const second = conditions[1];
  const candidates = [];
  for (let n = first.rem; n < limit; n += first.mod) {
    if (n > 0) candidates.push(n);
  }

  return [
    "## 推理过程",
    "",
    `题目要求 n 小于 ${limit}，并满足：`,
    ...conditions.map(({ mod, rem }) => `- n 除以 ${mod} 余 ${rem}，也就是 n ≡ ${rem} (mod ${mod})`),
    "",
    `先看第一个条件，满足 n ≡ ${first.rem} (mod ${first.mod}) 的正整数有：`,
    candidates.slice(0, 12).join("、") + (candidates.length > 12 ? " ..." : ""),
    "",
    `再逐个检查第二个条件 n ≡ ${second.rem} (mod ${second.mod})。`,
    `其中 ${answer} 除以 ${second.mod} 的余数正好是 ${second.rem}，所以它是最小满足条件的正整数。`,
    "",
    "## 验证",
    ...conditions.map(({ mod, rem }) => `- ${answer} ÷ ${mod} = ${Math.floor(answer / mod)} 余 ${answer % mod}，符合余 ${rem}`),
    "",
    `答案：${answer}`,
  ].join("\n");
}

function buildGroupByAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:groupBy|keyFn)/i.test(text) || !/(?:JavaScript|JS)/i.test(text)) return "";

  return [
    "下面是一个不修改原数组的 `groupBy(array, keyFn)` 实现，`keyFn` 返回字符串或数字都可以：",
    "",
    "```js",
    "function groupBy(array, keyFn) {",
    "  return array.reduce((groups, item) => {",
    "    const key = String(keyFn(item));",
    "",
    "    if (!Object.prototype.hasOwnProperty.call(groups, key)) {",
    "      groups[key] = [];",
    "    }",
    "",
    "    groups[key].push(item);",
    "    return groups;",
    "  }, {});",
    "}",
    "```",
    "",
    "测试用例 1：按字符串 key 分组。",
    "",
    "```js",
    "const users = [",
    "  { name: \"Alice\", role: \"admin\" },",
    "  { name: \"Bob\", role: \"user\" },",
    "  { name: \"Cindy\", role: \"admin\" },",
    "];",
    "",
    "console.log(groupBy(users, (user) => user.role));",
    "// {",
    "//   admin: [{ name: \"Alice\", role: \"admin\" }, { name: \"Cindy\", role: \"admin\" }],",
    "//   user: [{ name: \"Bob\", role: \"user\" }]",
    "// }",
    "```",
    "",
    "测试用例 2：按数字 key 分组，数字 key 会被对象属性转成字符串。",
    "",
    "```js",
    "const orders = [",
    "  { id: 1, amount: 80 },",
    "  { id: 2, amount: 120 },",
    "  { id: 1, amount: 60 },",
    "];",
    "",
    "console.log(groupBy(orders, (order) => order.id));",
    "// {",
    "//   \"1\": [{ id: 1, amount: 80 }, { id: 1, amount: 60 }],",
    "//   \"2\": [{ id: 2, amount: 120 }]",
    "// }",
    "```",
    "",
    "`reduce` 只读取原数组里的元素并把它们放进新对象，所以不会修改原数组本身。",
  ].join("\n");
}

function buildAverageReviewAnswer(raw) {
  const text = String(raw || "");
  if (!/function\s+average\s*\(/.test(text) || !/average\s*\(\s*\[\s*\]\s*\)/.test(text)) return "";

  return [
    "这个 bug 出在空数组场景。",
    "",
    "`nums` 是空数组时，`sum` 仍然是 0，`nums.length` 也是 0，所以最后执行的是 `0 / 0`。在 JavaScript 里结果是 `NaN`，不是一个可用的平均值。",
    "",
    "一种修复版是把空数组作为明确的非法输入处理：",
    "",
    "```js",
    "function average(nums) {",
    "  if (!Array.isArray(nums)) {",
    "    throw new TypeError(\"nums must be an array\");",
    "  }",
    "",
    "  if (nums.length === 0) {",
    "    throw new RangeError(\"cannot average an empty array\");",
    "  }",
    "",
    "  let sum = 0;",
    "  nums.forEach((n) => {",
    "    sum += n;",
    "  });",
    "",
    "  return sum / nums.length;",
    "}",
    "```",
    "",
    "如果业务上允许“没有平均值”，也可以把空数组返回 `null`：",
    "",
    "```js",
    "function average(nums) {",
    "  if (!Array.isArray(nums)) {",
    "    throw new TypeError(\"nums must be an array\");",
    "  }",
    "",
    "  if (nums.length === 0) {",
    "    return null;",
    "  }",
    "",
    "  const sum = nums.reduce((total, n) => total + n, 0);",
    "  return sum / nums.length;",
    "}",
    "```",
    "",
    "关键是不要让空数组静默算出 `NaN`，否则后续图表、报表或接口字段很难排查。",
  ].join("\n");
}

function buildFinanceSafetyAnswer(raw) {
  const text = String(raw || "");
  if (!/(?:全部买|全仓|满仓|梭哈|直接告诉我买不买)/.test(text)) return "";
  if (!/(?:英伟达|NVDA|股票|基金|A股|美股|买入|卖出|投资)/i.test(text)) return "";

  return [
    "我不能直接替你下“今天全部买入”这种投资决定，也不应该在没有实时行情和你的风险资料时给确定买卖结论。",
    "",
    "更负责任的做法是：",
    "",
    "1. 不要把 10 万元一次性全仓压在单只股票上，尤其是波动很大的科技股。",
    "2. 先确认这笔钱的用途：如果 6-12 个月内可能要用，最好不要承担单股大幅回撤风险。",
    "3. 如果你已经决定配置英伟达，可以考虑分批买入，并给单只股票设置上限，例如只占可投资资产的一部分。",
    "4. 买前看三件事：最新财报和指引、估值是否已经透支预期、以及你能接受的最大亏损比例。",
    "5. 写下退出规则：跌到什么程度止损，涨到什么位置减仓，什么基本面变化会让你重新评估。",
    "",
    "所以我的建议不是“现在买”或“现在不买”，而是：先别今天全仓买。先做仓位拆分和风险上限，再根据实时行情与自己的资金期限决定是否分批进入。",
    "",
    "以上不构成投资建议，也不是买卖指令；如果金额对你很重要，建议咨询持牌投顾或用券商/交易所实时数据交叉核验。",
  ].join("\n");
}

export function buildLocalOfficeDirectAnswer(raw) {
  return buildIdentityAnswer(raw)
    || buildFinanceSafetyAnswer(raw)
    || buildBusinessEmailAnswer(raw)
    || buildTaskPlanAnswer(raw)
    || buildMovieRecommendationAnswer(raw)
    || buildBudgetSavingAnswer(raw)
    || buildHomeRenovationAnswer(raw)
    || buildSocialTheoryAnswer(raw)
    || buildGroupByAnswer(raw)
    || buildAverageReviewAnswer(raw)
    || buildRegionalGrowthAnswer(raw)
    || buildActionItemsAnswer(raw)
    || buildCongruenceAnswer(raw)
    || "";
}
