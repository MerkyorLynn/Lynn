// Brain v2 · tool-exec/weather
// wttr.in 免费 API + web_search fallback
const CITY_EN_MAP = {
  '北京': 'Beijing', '上海': 'Shanghai', '广州': 'Guangzhou', '深圳': 'Shenzhen',
  '深圳南山': 'Shenzhen', '深圳福田': 'Shenzhen', '深圳罗湖': 'Shenzhen', '深圳宝安': 'Shenzhen',
  '杭州': 'Hangzhou', '成都': 'Chengdu', '重庆': 'Chongqing', '武汉': 'Wuhan',
  '南京': 'Nanjing', '天津': 'Tianjin', '苏州': 'Suzhou', '西安': "Xi'an",
  '长沙': 'Changsha', '沈阳': 'Shenyang', '青岛': 'Qingdao', '大连': 'Dalian',
  '厦门': 'Xiamen', '郑州': 'Zhengzhou', '东莞': 'Dongguan', '佛山': 'Foshan',
  '合肥': 'Hefei', '昆明': 'Kunming', '哈尔滨': 'Harbin', '济南': 'Jinan',
  '福州': 'Fuzhou', '珠海': 'Zhuhai', '无锡': 'Wuxi', '温州': 'Wenzhou',
  '宁波': 'Ningbo', '贵阳': 'Guiyang', '南宁': 'Nanning', '太原': 'Taiyuan',
  '石家庄': 'Shijiazhuang', '乌鲁木齐': 'Urumqi', '兰州': 'Lanzhou', '海口': 'Haikou',
  '三亚': 'Sanya', '拉萨': 'Lhasa', '香港': 'Hong Kong', '澳门': 'Macau', '台北': 'Taipei',
};

async function fetchWttr(displayCity, queryCity) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const resp = await fetch('https://wttr.in/' + encodeURIComponent(queryCity) + '?format=j1&lang=zh', {
      headers: { 'User-Agent': 'lobster-brain-v2/0.0' },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('wttr.in ' + resp.status);
    const data = await resp.json();
    const cur = data.current_condition?.[0];
    if (!cur) throw new Error('no current condition');

    const weatherText = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '未知';
    let summary = '【' + displayCity + '实时天气】\n';
    summary += '🌡 温度:' + cur.temp_C + '°C(体感 ' + cur.FeelsLikeC + '°C)\n';
    summary += '☁ 天气:' + weatherText + '\n';
    summary += '💧 湿度:' + cur.humidity + '%\n';
    summary += '🌬 风:' + cur.winddir16Point + ' ' + cur.windspeedKmph + 'km/h\n';
    summary += '👁 能见度:' + cur.visibility + 'km\n';
    summary += '☔ 降水:' + cur.precipMM + 'mm';
    if (cur.uvIndex && cur.uvIndex !== '0') summary += '\n☀ 紫外线指数:' + cur.uvIndex;

    if (data.weather?.length) {
      summary += '\n\n【未来天气预报】';
      for (const day of data.weather.slice(0, 3)) {
        const w = day.hourly?.[4]?.lang_zh?.[0]?.value || '未知';
        summary += '\n📅 ' + day.date + ':' + w + ',' + day.mintempC + '~' + day.maxtempC + '°C';
      }
    }
    return summary;
  } finally {
    clearTimeout(timeout);
  }
}

export async function weather(city, { log, webSearchFn } = {}) {
  const displayCity = String(city || '').trim() || '北京';
  const queryCity = CITY_EN_MAP[displayCity] || displayCity;
  try {
    const r = await fetchWttr(displayCity, queryCity);
    log && log('info', 'tool-exec/weather wttr OK ' + displayCity);
    return r;
  } catch (e) {
    log && log('warn', 'tool-exec/weather wttr fail ' + displayCity + ': ' + e.message);
    if (webSearchFn) {
      try {
        const fb = await webSearchFn(displayCity + ' 今天天气 温度 降水概率 实时 中央气象台');
        if (fb) return fb;
      } catch (we) {
        log && log('warn', 'tool-exec/weather web_search fallback fail: ' + we.message);
      }
    }
    return JSON.stringify({ error: 'weather lookup failed: wttr down + no search fallback' });
  }
}

export const __testing__ = { CITY_EN_MAP };
