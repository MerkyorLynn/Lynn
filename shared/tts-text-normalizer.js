const DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const SMALL_UNITS = ["", "十", "百", "千"];
const BIG_UNITS = ["", "万", "亿"];

function digitByDigit(value) {
  return String(value)
    .split("")
    .map((ch) => (/\d/.test(ch) ? DIGITS[Number(ch)] : ch))
    .join("");
}

function integerUnder10000ToChinese(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return DIGITS[0];
  const chars = String(Math.trunc(n)).split("").map(Number);
  const len = chars.length;
  let out = "";
  let pendingZero = false;
  for (let i = 0; i < chars.length; i += 1) {
    const d = chars[i];
    const unit = SMALL_UNITS[len - i - 1];
    if (d === 0) {
      pendingZero = out.length > 0;
      continue;
    }
    if (pendingZero) {
      out += DIGITS[0];
      pendingZero = false;
    }
    out += DIGITS[d] + unit;
  }
  return out.replace(/^一十/, "十");
}

function integerToChinese(value) {
  const raw = String(value || "0");
  if (/^0\d+$/.test(raw) || raw.length >= 5) return digitByDigit(raw);
  let n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  n = Math.trunc(n);
  if (n === 0) return DIGITS[0];
  const parts = [];
  let unitIndex = 0;
  while (n > 0) {
    const part = n % 10000;
    if (part > 0) {
      parts.unshift(`${integerUnder10000ToChinese(part)}${BIG_UNITS[unitIndex] || ""}`);
    } else if (parts.length && !parts[0].startsWith(DIGITS[0])) {
      parts.unshift(DIGITS[0]);
    }
    n = Math.floor(n / 10000);
    unitIndex += 1;
  }
  return parts.join("").replace(/零+/g, "零").replace(/零$/g, "");
}

function numberToChinese(rawValue, opts = {}) {
  const raw = String(rawValue || "").trim();
  if (!raw) return raw;
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [intPart, decimalPart] = unsigned.split(".");
  const integer = opts.digitByDigit ? digitByDigit(intPart) : integerToChinese(intPart);
  const decimal = decimalPart !== undefined ? `点${digitByDigit(decimalPart)}` : "";
  return `${negative ? "负" : ""}${integer}${decimal}`;
}

function normalizeDateSeparators(text) {
  return text
    .replace(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, (_m, y, mo, d) => (
      `${digitByDigit(y)}年${numberToChinese(Number(mo))}月${numberToChinese(Number(d))}日`
    ))
    .replace(/\b(20\d{2})年/g, (_m, y) => `${digitByDigit(y)}年`)
    .replace(/\b(\d{1,2})月(\d{1,2})(日|号)?/g, (_m, mo, d, suffix = "日") => (
      `${numberToChinese(mo)}月${numberToChinese(d)}${suffix || "日"}`
    ));
}

function normalizeUnits(text) {
  return text
    .replace(/(-?\d+(?:\.\d+)?)\s*[~～\-—–至到]\s*(-?\d+(?:\.\d+)?)\s*(?:°\s*C|℃|摄氏度)/gi, (_m, a, b) => (
      `${numberToChinese(a)}到${numberToChinese(b)}摄氏度`
    ))
    .replace(/(-?\d+(?:\.\d+)?)\s*[~～\-—–至到]\s*(-?\d+(?:\.\d+)?)\s*度/g, (_m, a, b) => (
      `${numberToChinese(a)}到${numberToChinese(b)}度`
    ))
    .replace(/(-?\d+(?:\.\d+)?)\s*(?:°\s*C|℃)/gi, (_m, n) => `${numberToChinese(n)}摄氏度`)
    .replace(/(-?\d+(?:\.\d+)?)\s*%/g, (_m, n) => `百分之${numberToChinese(n)}`)
    .replace(/(-?\d+(?:\.\d+)?)\s*(?:km\/h|公里\/小时)/gi, (_m, n) => `${numberToChinese(n)}公里每小时`)
    .replace(/(-?\d+(?:\.\d+)?)\s*mm\b/gi, (_m, n) => `${numberToChinese(n)}毫米`)
    .replace(/(-?\d+(?:\.\d+)?)\s*(?:元\/克|元\/g)/gi, (_m, n) => `${numberToChinese(n)}元每克`);
}

function normalizeCurrencyAndSymbols(text) {
  return text
    .replace(/\bXAU\/USD\b/gi, "国际现货黄金")
    .replace(/\bXAG\/USD\b/gi, "国际现货白银")
    .replace(/\bHKD\b/g, "港元")
    .replace(/\bUSD\b/g, "美元")
    .replace(/\bCNY\b/g, "人民币")
    .replace(/\bRMB\b/g, "人民币");
}

function normalizeRemainingNumbers(text) {
  return text.replace(/-?\d+(?:\.\d+)?/g, (match, offset, full) => {
    const prev = full[offset - 1] || "";
    const next = full[offset + match.length] || "";
    if ((prev === "/" || prev === ":") && /[A-Za-z]/.test(next)) return match;
    const digitByDigitMode = /^-?0\d+/.test(match) || match.replace(/^-/, "").split(".")[0].length >= 5;
    return numberToChinese(match, { digitByDigit: digitByDigitMode });
  });
}

export function normalizeChineseTtsText(value) {
  const input = String(value || "");
  if (!input.trim()) return "";
  return normalizeRemainingNumbers(
    normalizeCurrencyAndSymbols(
      normalizeUnits(
        normalizeDateSeparators(input),
      ),
    ),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export const __ttsTextNormalizerInternals = {
  digitByDigit,
  integerToChinese,
  numberToChinese,
};
