"use strict";
const require$$0 = require("electron");
const require$$1 = require("os");
const require$$2 = require("path");
const require$$3 = require("child_process");
const require$$4 = require("fs");
const require$$8 = require("ws");
function getDefaultExportFromCjs(x) {
  return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
function getAugmentedNamespace(n) {
  if (Object.prototype.hasOwnProperty.call(n, "__esModule")) return n;
  var f = n.default;
  if (typeof f == "function") {
    var a = function a2() {
      var isInstance = false;
      try {
        isInstance = this instanceof a2;
      } catch {
      }
      if (isInstance) {
        return Reflect.construct(f, arguments, this.constructor);
      }
      return f.apply(this, arguments);
    };
    a.prototype = f.prototype;
  } else a = {};
  Object.defineProperty(a, "__esModule", { value: true });
  Object.keys(n).forEach(function(k) {
    var d = Object.getOwnPropertyDescriptor(n, k);
    Object.defineProperty(a, k, d.get ? d : {
      enumerable: true,
      get: function() {
        return n[k];
      }
    });
  });
  return a;
}
var main$1 = {};
function isNothing(subject) {
  return typeof subject === "undefined" || subject === null;
}
function isObject(subject) {
  return typeof subject === "object" && subject !== null;
}
function toArray(sequence) {
  if (Array.isArray(sequence)) return sequence;
  else if (isNothing(sequence)) return [];
  return [sequence];
}
function extend(target, source) {
  var index, length, key, sourceKeys;
  if (source) {
    sourceKeys = Object.keys(source);
    for (index = 0, length = sourceKeys.length; index < length; index += 1) {
      key = sourceKeys[index];
      target[key] = source[key];
    }
  }
  return target;
}
function repeat(string, count) {
  var result = "", cycle;
  for (cycle = 0; cycle < count; cycle += 1) {
    result += string;
  }
  return result;
}
function isNegativeZero(number) {
  return number === 0 && Number.NEGATIVE_INFINITY === 1 / number;
}
var isNothing_1 = isNothing;
var isObject_1 = isObject;
var toArray_1 = toArray;
var repeat_1 = repeat;
var isNegativeZero_1 = isNegativeZero;
var extend_1 = extend;
var common = {
  isNothing: isNothing_1,
  isObject: isObject_1,
  toArray: toArray_1,
  repeat: repeat_1,
  isNegativeZero: isNegativeZero_1,
  extend: extend_1
};
function formatError(exception2, compact) {
  var where = "", message = exception2.reason || "(unknown reason)";
  if (!exception2.mark) return message;
  if (exception2.mark.name) {
    where += 'in "' + exception2.mark.name + '" ';
  }
  where += "(" + (exception2.mark.line + 1) + ":" + (exception2.mark.column + 1) + ")";
  if (!compact && exception2.mark.snippet) {
    where += "\n\n" + exception2.mark.snippet;
  }
  return message + " " + where;
}
function YAMLException$1(reason, mark) {
  Error.call(this);
  this.name = "YAMLException";
  this.reason = reason;
  this.mark = mark;
  this.message = formatError(this, false);
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, this.constructor);
  } else {
    this.stack = new Error().stack || "";
  }
}
YAMLException$1.prototype = Object.create(Error.prototype);
YAMLException$1.prototype.constructor = YAMLException$1;
YAMLException$1.prototype.toString = function toString(compact) {
  return this.name + ": " + formatError(this, compact);
};
var exception = YAMLException$1;
function getLine(buffer, lineStart, lineEnd, position, maxLineLength) {
  var head = "";
  var tail = "";
  var maxHalfLength = Math.floor(maxLineLength / 2) - 1;
  if (position - lineStart > maxHalfLength) {
    head = " ... ";
    lineStart = position - maxHalfLength + head.length;
  }
  if (lineEnd - position > maxHalfLength) {
    tail = " ...";
    lineEnd = position + maxHalfLength - tail.length;
  }
  return {
    str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, "→") + tail,
    pos: position - lineStart + head.length
    // relative position
  };
}
function padStart(string, max) {
  return common.repeat(" ", max - string.length) + string;
}
function makeSnippet(mark, options) {
  options = Object.create(options || null);
  if (!mark.buffer) return null;
  if (!options.maxLength) options.maxLength = 79;
  if (typeof options.indent !== "number") options.indent = 1;
  if (typeof options.linesBefore !== "number") options.linesBefore = 3;
  if (typeof options.linesAfter !== "number") options.linesAfter = 2;
  var re = /\r?\n|\r|\0/g;
  var lineStarts = [0];
  var lineEnds = [];
  var match;
  var foundLineNo = -1;
  while (match = re.exec(mark.buffer)) {
    lineEnds.push(match.index);
    lineStarts.push(match.index + match[0].length);
    if (mark.position <= match.index && foundLineNo < 0) {
      foundLineNo = lineStarts.length - 2;
    }
  }
  if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;
  var result = "", i, line;
  var lineNoLength = Math.min(mark.line + options.linesAfter, lineEnds.length).toString().length;
  var maxLineLength = options.maxLength - (options.indent + lineNoLength + 3);
  for (i = 1; i <= options.linesBefore; i++) {
    if (foundLineNo - i < 0) break;
    line = getLine(
      mark.buffer,
      lineStarts[foundLineNo - i],
      lineEnds[foundLineNo - i],
      mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i]),
      maxLineLength
    );
    result = common.repeat(" ", options.indent) + padStart((mark.line - i + 1).toString(), lineNoLength) + " | " + line.str + "\n" + result;
  }
  line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
  result += common.repeat(" ", options.indent) + padStart((mark.line + 1).toString(), lineNoLength) + " | " + line.str + "\n";
  result += common.repeat("-", options.indent + lineNoLength + 3 + line.pos) + "^\n";
  for (i = 1; i <= options.linesAfter; i++) {
    if (foundLineNo + i >= lineEnds.length) break;
    line = getLine(
      mark.buffer,
      lineStarts[foundLineNo + i],
      lineEnds[foundLineNo + i],
      mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i]),
      maxLineLength
    );
    result += common.repeat(" ", options.indent) + padStart((mark.line + i + 1).toString(), lineNoLength) + " | " + line.str + "\n";
  }
  return result.replace(/\n$/, "");
}
var snippet = makeSnippet;
var TYPE_CONSTRUCTOR_OPTIONS = [
  "kind",
  "multi",
  "resolve",
  "construct",
  "instanceOf",
  "predicate",
  "represent",
  "representName",
  "defaultStyle",
  "styleAliases"
];
var YAML_NODE_KINDS = [
  "scalar",
  "sequence",
  "mapping"
];
function compileStyleAliases(map2) {
  var result = {};
  if (map2 !== null) {
    Object.keys(map2).forEach(function(style) {
      map2[style].forEach(function(alias) {
        result[String(alias)] = style;
      });
    });
  }
  return result;
}
function Type$1(tag, options) {
  options = options || {};
  Object.keys(options).forEach(function(name) {
    if (TYPE_CONSTRUCTOR_OPTIONS.indexOf(name) === -1) {
      throw new exception('Unknown option "' + name + '" is met in definition of "' + tag + '" YAML type.');
    }
  });
  this.options = options;
  this.tag = tag;
  this.kind = options["kind"] || null;
  this.resolve = options["resolve"] || function() {
    return true;
  };
  this.construct = options["construct"] || function(data) {
    return data;
  };
  this.instanceOf = options["instanceOf"] || null;
  this.predicate = options["predicate"] || null;
  this.represent = options["represent"] || null;
  this.representName = options["representName"] || null;
  this.defaultStyle = options["defaultStyle"] || null;
  this.multi = options["multi"] || false;
  this.styleAliases = compileStyleAliases(options["styleAliases"] || null);
  if (YAML_NODE_KINDS.indexOf(this.kind) === -1) {
    throw new exception('Unknown kind "' + this.kind + '" is specified for "' + tag + '" YAML type.');
  }
}
var type = Type$1;
function compileList(schema2, name) {
  var result = [];
  schema2[name].forEach(function(currentType) {
    var newIndex = result.length;
    result.forEach(function(previousType, previousIndex) {
      if (previousType.tag === currentType.tag && previousType.kind === currentType.kind && previousType.multi === currentType.multi) {
        newIndex = previousIndex;
      }
    });
    result[newIndex] = currentType;
  });
  return result;
}
function compileMap() {
  var result = {
    scalar: {},
    sequence: {},
    mapping: {},
    fallback: {},
    multi: {
      scalar: [],
      sequence: [],
      mapping: [],
      fallback: []
    }
  }, index, length;
  function collectType(type2) {
    if (type2.multi) {
      result.multi[type2.kind].push(type2);
      result.multi["fallback"].push(type2);
    } else {
      result[type2.kind][type2.tag] = result["fallback"][type2.tag] = type2;
    }
  }
  for (index = 0, length = arguments.length; index < length; index += 1) {
    arguments[index].forEach(collectType);
  }
  return result;
}
function Schema$1(definition) {
  return this.extend(definition);
}
Schema$1.prototype.extend = function extend2(definition) {
  var implicit = [];
  var explicit = [];
  if (definition instanceof type) {
    explicit.push(definition);
  } else if (Array.isArray(definition)) {
    explicit = explicit.concat(definition);
  } else if (definition && (Array.isArray(definition.implicit) || Array.isArray(definition.explicit))) {
    if (definition.implicit) implicit = implicit.concat(definition.implicit);
    if (definition.explicit) explicit = explicit.concat(definition.explicit);
  } else {
    throw new exception("Schema.extend argument should be a Type, [ Type ], or a schema definition ({ implicit: [...], explicit: [...] })");
  }
  implicit.forEach(function(type$1) {
    if (!(type$1 instanceof type)) {
      throw new exception("Specified list of YAML types (or a single Type object) contains a non-Type object.");
    }
    if (type$1.loadKind && type$1.loadKind !== "scalar") {
      throw new exception("There is a non-scalar type in the implicit list of a schema. Implicit resolving of such types is not supported.");
    }
    if (type$1.multi) {
      throw new exception("There is a multi type in the implicit list of a schema. Multi tags can only be listed as explicit.");
    }
  });
  explicit.forEach(function(type$1) {
    if (!(type$1 instanceof type)) {
      throw new exception("Specified list of YAML types (or a single Type object) contains a non-Type object.");
    }
  });
  var result = Object.create(Schema$1.prototype);
  result.implicit = (this.implicit || []).concat(implicit);
  result.explicit = (this.explicit || []).concat(explicit);
  result.compiledImplicit = compileList(result, "implicit");
  result.compiledExplicit = compileList(result, "explicit");
  result.compiledTypeMap = compileMap(result.compiledImplicit, result.compiledExplicit);
  return result;
};
var schema = Schema$1;
var str = new type("tag:yaml.org,2002:str", {
  kind: "scalar",
  construct: function(data) {
    return data !== null ? data : "";
  }
});
var seq = new type("tag:yaml.org,2002:seq", {
  kind: "sequence",
  construct: function(data) {
    return data !== null ? data : [];
  }
});
var map = new type("tag:yaml.org,2002:map", {
  kind: "mapping",
  construct: function(data) {
    return data !== null ? data : {};
  }
});
var failsafe = new schema({
  explicit: [
    str,
    seq,
    map
  ]
});
function resolveYamlNull(data) {
  if (data === null) return true;
  var max = data.length;
  return max === 1 && data === "~" || max === 4 && (data === "null" || data === "Null" || data === "NULL");
}
function constructYamlNull() {
  return null;
}
function isNull(object) {
  return object === null;
}
var _null = new type("tag:yaml.org,2002:null", {
  kind: "scalar",
  resolve: resolveYamlNull,
  construct: constructYamlNull,
  predicate: isNull,
  represent: {
    canonical: function() {
      return "~";
    },
    lowercase: function() {
      return "null";
    },
    uppercase: function() {
      return "NULL";
    },
    camelcase: function() {
      return "Null";
    },
    empty: function() {
      return "";
    }
  },
  defaultStyle: "lowercase"
});
function resolveYamlBoolean(data) {
  if (data === null) return false;
  var max = data.length;
  return max === 4 && (data === "true" || data === "True" || data === "TRUE") || max === 5 && (data === "false" || data === "False" || data === "FALSE");
}
function constructYamlBoolean(data) {
  return data === "true" || data === "True" || data === "TRUE";
}
function isBoolean(object) {
  return Object.prototype.toString.call(object) === "[object Boolean]";
}
var bool = new type("tag:yaml.org,2002:bool", {
  kind: "scalar",
  resolve: resolveYamlBoolean,
  construct: constructYamlBoolean,
  predicate: isBoolean,
  represent: {
    lowercase: function(object) {
      return object ? "true" : "false";
    },
    uppercase: function(object) {
      return object ? "TRUE" : "FALSE";
    },
    camelcase: function(object) {
      return object ? "True" : "False";
    }
  },
  defaultStyle: "lowercase"
});
function isHexCode(c) {
  return 48 <= c && c <= 57 || 65 <= c && c <= 70 || 97 <= c && c <= 102;
}
function isOctCode(c) {
  return 48 <= c && c <= 55;
}
function isDecCode(c) {
  return 48 <= c && c <= 57;
}
function resolveYamlInteger(data) {
  if (data === null) return false;
  var max = data.length, index = 0, hasDigits = false, ch;
  if (!max) return false;
  ch = data[index];
  if (ch === "-" || ch === "+") {
    ch = data[++index];
  }
  if (ch === "0") {
    if (index + 1 === max) return true;
    ch = data[++index];
    if (ch === "b") {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === "_") continue;
        if (ch !== "0" && ch !== "1") return false;
        hasDigits = true;
      }
      return hasDigits && ch !== "_";
    }
    if (ch === "x") {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === "_") continue;
        if (!isHexCode(data.charCodeAt(index))) return false;
        hasDigits = true;
      }
      return hasDigits && ch !== "_";
    }
    if (ch === "o") {
      index++;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === "_") continue;
        if (!isOctCode(data.charCodeAt(index))) return false;
        hasDigits = true;
      }
      return hasDigits && ch !== "_";
    }
  }
  if (ch === "_") return false;
  for (; index < max; index++) {
    ch = data[index];
    if (ch === "_") continue;
    if (!isDecCode(data.charCodeAt(index))) {
      return false;
    }
    hasDigits = true;
  }
  if (!hasDigits || ch === "_") return false;
  return true;
}
function constructYamlInteger(data) {
  var value = data, sign = 1, ch;
  if (value.indexOf("_") !== -1) {
    value = value.replace(/_/g, "");
  }
  ch = value[0];
  if (ch === "-" || ch === "+") {
    if (ch === "-") sign = -1;
    value = value.slice(1);
    ch = value[0];
  }
  if (value === "0") return 0;
  if (ch === "0") {
    if (value[1] === "b") return sign * parseInt(value.slice(2), 2);
    if (value[1] === "x") return sign * parseInt(value.slice(2), 16);
    if (value[1] === "o") return sign * parseInt(value.slice(2), 8);
  }
  return sign * parseInt(value, 10);
}
function isInteger(object) {
  return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 === 0 && !common.isNegativeZero(object));
}
var int = new type("tag:yaml.org,2002:int", {
  kind: "scalar",
  resolve: resolveYamlInteger,
  construct: constructYamlInteger,
  predicate: isInteger,
  represent: {
    binary: function(obj) {
      return obj >= 0 ? "0b" + obj.toString(2) : "-0b" + obj.toString(2).slice(1);
    },
    octal: function(obj) {
      return obj >= 0 ? "0o" + obj.toString(8) : "-0o" + obj.toString(8).slice(1);
    },
    decimal: function(obj) {
      return obj.toString(10);
    },
    /* eslint-disable max-len */
    hexadecimal: function(obj) {
      return obj >= 0 ? "0x" + obj.toString(16).toUpperCase() : "-0x" + obj.toString(16).toUpperCase().slice(1);
    }
  },
  defaultStyle: "decimal",
  styleAliases: {
    binary: [2, "bin"],
    octal: [8, "oct"],
    decimal: [10, "dec"],
    hexadecimal: [16, "hex"]
  }
});
var YAML_FLOAT_PATTERN = new RegExp(
  // 2.5e4, 2.5 and integers
  "^(?:[-+]?(?:[0-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$"
);
function resolveYamlFloat(data) {
  if (data === null) return false;
  if (!YAML_FLOAT_PATTERN.test(data) || // Quick hack to not allow integers end with `_`
  // Probably should update regexp & check speed
  data[data.length - 1] === "_") {
    return false;
  }
  return true;
}
function constructYamlFloat(data) {
  var value, sign;
  value = data.replace(/_/g, "").toLowerCase();
  sign = value[0] === "-" ? -1 : 1;
  if ("+-".indexOf(value[0]) >= 0) {
    value = value.slice(1);
  }
  if (value === ".inf") {
    return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  } else if (value === ".nan") {
    return NaN;
  }
  return sign * parseFloat(value, 10);
}
var SCIENTIFIC_WITHOUT_DOT = /^[-+]?[0-9]+e/;
function representYamlFloat(object, style) {
  var res;
  if (isNaN(object)) {
    switch (style) {
      case "lowercase":
        return ".nan";
      case "uppercase":
        return ".NAN";
      case "camelcase":
        return ".NaN";
    }
  } else if (Number.POSITIVE_INFINITY === object) {
    switch (style) {
      case "lowercase":
        return ".inf";
      case "uppercase":
        return ".INF";
      case "camelcase":
        return ".Inf";
    }
  } else if (Number.NEGATIVE_INFINITY === object) {
    switch (style) {
      case "lowercase":
        return "-.inf";
      case "uppercase":
        return "-.INF";
      case "camelcase":
        return "-.Inf";
    }
  } else if (common.isNegativeZero(object)) {
    return "-0.0";
  }
  res = object.toString(10);
  return SCIENTIFIC_WITHOUT_DOT.test(res) ? res.replace("e", ".e") : res;
}
function isFloat(object) {
  return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 !== 0 || common.isNegativeZero(object));
}
var float = new type("tag:yaml.org,2002:float", {
  kind: "scalar",
  resolve: resolveYamlFloat,
  construct: constructYamlFloat,
  predicate: isFloat,
  represent: representYamlFloat,
  defaultStyle: "lowercase"
});
var json = failsafe.extend({
  implicit: [
    _null,
    bool,
    int,
    float
  ]
});
var core = json;
var YAML_DATE_REGEXP = new RegExp(
  "^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$"
);
var YAML_TIMESTAMP_REGEXP = new RegExp(
  "^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$"
);
function resolveYamlTimestamp(data) {
  if (data === null) return false;
  if (YAML_DATE_REGEXP.exec(data) !== null) return true;
  if (YAML_TIMESTAMP_REGEXP.exec(data) !== null) return true;
  return false;
}
function constructYamlTimestamp(data) {
  var match, year, month, day, hour, minute, second, fraction = 0, delta = null, tz_hour, tz_minute, date;
  match = YAML_DATE_REGEXP.exec(data);
  if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(data);
  if (match === null) throw new Error("Date resolve error");
  year = +match[1];
  month = +match[2] - 1;
  day = +match[3];
  if (!match[4]) {
    return new Date(Date.UTC(year, month, day));
  }
  hour = +match[4];
  minute = +match[5];
  second = +match[6];
  if (match[7]) {
    fraction = match[7].slice(0, 3);
    while (fraction.length < 3) {
      fraction += "0";
    }
    fraction = +fraction;
  }
  if (match[9]) {
    tz_hour = +match[10];
    tz_minute = +(match[11] || 0);
    delta = (tz_hour * 60 + tz_minute) * 6e4;
    if (match[9] === "-") delta = -delta;
  }
  date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
  if (delta) date.setTime(date.getTime() - delta);
  return date;
}
function representYamlTimestamp(object) {
  return object.toISOString();
}
var timestamp = new type("tag:yaml.org,2002:timestamp", {
  kind: "scalar",
  resolve: resolveYamlTimestamp,
  construct: constructYamlTimestamp,
  instanceOf: Date,
  represent: representYamlTimestamp
});
function resolveYamlMerge(data) {
  return data === "<<" || data === null;
}
var merge = new type("tag:yaml.org,2002:merge", {
  kind: "scalar",
  resolve: resolveYamlMerge
});
var BASE64_MAP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r";
function resolveYamlBinary(data) {
  if (data === null) return false;
  var code, idx, bitlen = 0, max = data.length, map2 = BASE64_MAP;
  for (idx = 0; idx < max; idx++) {
    code = map2.indexOf(data.charAt(idx));
    if (code > 64) continue;
    if (code < 0) return false;
    bitlen += 6;
  }
  return bitlen % 8 === 0;
}
function constructYamlBinary(data) {
  var idx, tailbits, input = data.replace(/[\r\n=]/g, ""), max = input.length, map2 = BASE64_MAP, bits = 0, result = [];
  for (idx = 0; idx < max; idx++) {
    if (idx % 4 === 0 && idx) {
      result.push(bits >> 16 & 255);
      result.push(bits >> 8 & 255);
      result.push(bits & 255);
    }
    bits = bits << 6 | map2.indexOf(input.charAt(idx));
  }
  tailbits = max % 4 * 6;
  if (tailbits === 0) {
    result.push(bits >> 16 & 255);
    result.push(bits >> 8 & 255);
    result.push(bits & 255);
  } else if (tailbits === 18) {
    result.push(bits >> 10 & 255);
    result.push(bits >> 2 & 255);
  } else if (tailbits === 12) {
    result.push(bits >> 4 & 255);
  }
  return new Uint8Array(result);
}
function representYamlBinary(object) {
  var result = "", bits = 0, idx, tail, max = object.length, map2 = BASE64_MAP;
  for (idx = 0; idx < max; idx++) {
    if (idx % 3 === 0 && idx) {
      result += map2[bits >> 18 & 63];
      result += map2[bits >> 12 & 63];
      result += map2[bits >> 6 & 63];
      result += map2[bits & 63];
    }
    bits = (bits << 8) + object[idx];
  }
  tail = max % 3;
  if (tail === 0) {
    result += map2[bits >> 18 & 63];
    result += map2[bits >> 12 & 63];
    result += map2[bits >> 6 & 63];
    result += map2[bits & 63];
  } else if (tail === 2) {
    result += map2[bits >> 10 & 63];
    result += map2[bits >> 4 & 63];
    result += map2[bits << 2 & 63];
    result += map2[64];
  } else if (tail === 1) {
    result += map2[bits >> 2 & 63];
    result += map2[bits << 4 & 63];
    result += map2[64];
    result += map2[64];
  }
  return result;
}
function isBinary(obj) {
  return Object.prototype.toString.call(obj) === "[object Uint8Array]";
}
var binary = new type("tag:yaml.org,2002:binary", {
  kind: "scalar",
  resolve: resolveYamlBinary,
  construct: constructYamlBinary,
  predicate: isBinary,
  represent: representYamlBinary
});
var _hasOwnProperty$3 = Object.prototype.hasOwnProperty;
var _toString$2 = Object.prototype.toString;
function resolveYamlOmap(data) {
  if (data === null) return true;
  var objectKeys = [], index, length, pair, pairKey, pairHasKey, object = data;
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    pairHasKey = false;
    if (_toString$2.call(pair) !== "[object Object]") return false;
    for (pairKey in pair) {
      if (_hasOwnProperty$3.call(pair, pairKey)) {
        if (!pairHasKey) pairHasKey = true;
        else return false;
      }
    }
    if (!pairHasKey) return false;
    if (objectKeys.indexOf(pairKey) === -1) objectKeys.push(pairKey);
    else return false;
  }
  return true;
}
function constructYamlOmap(data) {
  return data !== null ? data : [];
}
var omap = new type("tag:yaml.org,2002:omap", {
  kind: "sequence",
  resolve: resolveYamlOmap,
  construct: constructYamlOmap
});
var _toString$1 = Object.prototype.toString;
function resolveYamlPairs(data) {
  if (data === null) return true;
  var index, length, pair, keys, result, object = data;
  result = new Array(object.length);
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    if (_toString$1.call(pair) !== "[object Object]") return false;
    keys = Object.keys(pair);
    if (keys.length !== 1) return false;
    result[index] = [keys[0], pair[keys[0]]];
  }
  return true;
}
function constructYamlPairs(data) {
  if (data === null) return [];
  var index, length, pair, keys, result, object = data;
  result = new Array(object.length);
  for (index = 0, length = object.length; index < length; index += 1) {
    pair = object[index];
    keys = Object.keys(pair);
    result[index] = [keys[0], pair[keys[0]]];
  }
  return result;
}
var pairs = new type("tag:yaml.org,2002:pairs", {
  kind: "sequence",
  resolve: resolveYamlPairs,
  construct: constructYamlPairs
});
var _hasOwnProperty$2 = Object.prototype.hasOwnProperty;
function resolveYamlSet(data) {
  if (data === null) return true;
  var key, object = data;
  for (key in object) {
    if (_hasOwnProperty$2.call(object, key)) {
      if (object[key] !== null) return false;
    }
  }
  return true;
}
function constructYamlSet(data) {
  return data !== null ? data : {};
}
var set = new type("tag:yaml.org,2002:set", {
  kind: "mapping",
  resolve: resolveYamlSet,
  construct: constructYamlSet
});
var _default = core.extend({
  implicit: [
    timestamp,
    merge
  ],
  explicit: [
    binary,
    omap,
    pairs,
    set
  ]
});
var _hasOwnProperty$1 = Object.prototype.hasOwnProperty;
var CONTEXT_FLOW_IN = 1;
var CONTEXT_FLOW_OUT = 2;
var CONTEXT_BLOCK_IN = 3;
var CONTEXT_BLOCK_OUT = 4;
var CHOMPING_CLIP = 1;
var CHOMPING_STRIP = 2;
var CHOMPING_KEEP = 3;
var PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
var PATTERN_NON_ASCII_LINE_BREAKS = /[\x85\u2028\u2029]/;
var PATTERN_FLOW_INDICATORS = /[,\[\]\{\}]/;
var PATTERN_TAG_HANDLE = /^(?:!|!!|![a-z\-]+!)$/i;
var PATTERN_TAG_URI = /^(?:!|[^,\[\]\{\}])(?:%[0-9a-f]{2}|[0-9a-z\-#;\/\?:@&=\+\$,_\.!~\*'\(\)\[\]])*$/i;
function _class(obj) {
  return Object.prototype.toString.call(obj);
}
function is_EOL(c) {
  return c === 10 || c === 13;
}
function is_WHITE_SPACE(c) {
  return c === 9 || c === 32;
}
function is_WS_OR_EOL(c) {
  return c === 9 || c === 32 || c === 10 || c === 13;
}
function is_FLOW_INDICATOR(c) {
  return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
}
function fromHexCode(c) {
  var lc;
  if (48 <= c && c <= 57) {
    return c - 48;
  }
  lc = c | 32;
  if (97 <= lc && lc <= 102) {
    return lc - 97 + 10;
  }
  return -1;
}
function escapedHexLen(c) {
  if (c === 120) {
    return 2;
  }
  if (c === 117) {
    return 4;
  }
  if (c === 85) {
    return 8;
  }
  return 0;
}
function fromDecimalCode(c) {
  if (48 <= c && c <= 57) {
    return c - 48;
  }
  return -1;
}
function simpleEscapeSequence(c) {
  return c === 48 ? "\0" : c === 97 ? "\x07" : c === 98 ? "\b" : c === 116 ? "	" : c === 9 ? "	" : c === 110 ? "\n" : c === 118 ? "\v" : c === 102 ? "\f" : c === 114 ? "\r" : c === 101 ? "\x1B" : c === 32 ? " " : c === 34 ? '"' : c === 47 ? "/" : c === 92 ? "\\" : c === 78 ? "" : c === 95 ? " " : c === 76 ? "\u2028" : c === 80 ? "\u2029" : "";
}
function charFromCodepoint(c) {
  if (c <= 65535) {
    return String.fromCharCode(c);
  }
  return String.fromCharCode(
    (c - 65536 >> 10) + 55296,
    (c - 65536 & 1023) + 56320
  );
}
function setProperty(object, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value
    });
  } else {
    object[key] = value;
  }
}
var simpleEscapeCheck = new Array(256);
var simpleEscapeMap = new Array(256);
for (var i = 0; i < 256; i++) {
  simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
  simpleEscapeMap[i] = simpleEscapeSequence(i);
}
function State$1(input, options) {
  this.input = input;
  this.filename = options["filename"] || null;
  this.schema = options["schema"] || _default;
  this.onWarning = options["onWarning"] || null;
  this.legacy = options["legacy"] || false;
  this.json = options["json"] || false;
  this.listener = options["listener"] || null;
  this.implicitTypes = this.schema.compiledImplicit;
  this.typeMap = this.schema.compiledTypeMap;
  this.length = input.length;
  this.position = 0;
  this.line = 0;
  this.lineStart = 0;
  this.lineIndent = 0;
  this.firstTabInLine = -1;
  this.documents = [];
}
function generateError(state, message) {
  var mark = {
    name: state.filename,
    buffer: state.input.slice(0, -1),
    // omit trailing \0
    position: state.position,
    line: state.line,
    column: state.position - state.lineStart
  };
  mark.snippet = snippet(mark);
  return new exception(message, mark);
}
function throwError(state, message) {
  throw generateError(state, message);
}
function throwWarning(state, message) {
  if (state.onWarning) {
    state.onWarning.call(null, generateError(state, message));
  }
}
var directiveHandlers = {
  YAML: function handleYamlDirective(state, name, args) {
    var match, major, minor;
    if (state.version !== null) {
      throwError(state, "duplication of %YAML directive");
    }
    if (args.length !== 1) {
      throwError(state, "YAML directive accepts exactly one argument");
    }
    match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
    if (match === null) {
      throwError(state, "ill-formed argument of the YAML directive");
    }
    major = parseInt(match[1], 10);
    minor = parseInt(match[2], 10);
    if (major !== 1) {
      throwError(state, "unacceptable YAML version of the document");
    }
    state.version = args[0];
    state.checkLineBreaks = minor < 2;
    if (minor !== 1 && minor !== 2) {
      throwWarning(state, "unsupported YAML version of the document");
    }
  },
  TAG: function handleTagDirective(state, name, args) {
    var handle, prefix;
    if (args.length !== 2) {
      throwError(state, "TAG directive accepts exactly two arguments");
    }
    handle = args[0];
    prefix = args[1];
    if (!PATTERN_TAG_HANDLE.test(handle)) {
      throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
    }
    if (_hasOwnProperty$1.call(state.tagMap, handle)) {
      throwError(state, 'there is a previously declared suffix for "' + handle + '" tag handle');
    }
    if (!PATTERN_TAG_URI.test(prefix)) {
      throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
    }
    try {
      prefix = decodeURIComponent(prefix);
    } catch (err) {
      throwError(state, "tag prefix is malformed: " + prefix);
    }
    state.tagMap[handle] = prefix;
  }
};
function captureSegment(state, start, end, checkJson) {
  var _position, _length, _character, _result;
  if (start < end) {
    _result = state.input.slice(start, end);
    if (checkJson) {
      for (_position = 0, _length = _result.length; _position < _length; _position += 1) {
        _character = _result.charCodeAt(_position);
        if (!(_character === 9 || 32 <= _character && _character <= 1114111)) {
          throwError(state, "expected valid JSON character");
        }
      }
    } else if (PATTERN_NON_PRINTABLE.test(_result)) {
      throwError(state, "the stream contains non-printable characters");
    }
    state.result += _result;
  }
}
function mergeMappings(state, destination, source, overridableKeys) {
  var sourceKeys, key, index, quantity;
  if (!common.isObject(source)) {
    throwError(state, "cannot merge mappings; the provided source object is unacceptable");
  }
  sourceKeys = Object.keys(source);
  for (index = 0, quantity = sourceKeys.length; index < quantity; index += 1) {
    key = sourceKeys[index];
    if (!_hasOwnProperty$1.call(destination, key)) {
      setProperty(destination, key, source[key]);
      overridableKeys[key] = true;
    }
  }
}
function storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, startLine, startLineStart, startPos) {
  var index, quantity;
  if (Array.isArray(keyNode)) {
    keyNode = Array.prototype.slice.call(keyNode);
    for (index = 0, quantity = keyNode.length; index < quantity; index += 1) {
      if (Array.isArray(keyNode[index])) {
        throwError(state, "nested arrays are not supported inside keys");
      }
      if (typeof keyNode === "object" && _class(keyNode[index]) === "[object Object]") {
        keyNode[index] = "[object Object]";
      }
    }
  }
  if (typeof keyNode === "object" && _class(keyNode) === "[object Object]") {
    keyNode = "[object Object]";
  }
  keyNode = String(keyNode);
  if (_result === null) {
    _result = {};
  }
  if (keyTag === "tag:yaml.org,2002:merge") {
    if (Array.isArray(valueNode)) {
      for (index = 0, quantity = valueNode.length; index < quantity; index += 1) {
        mergeMappings(state, _result, valueNode[index], overridableKeys);
      }
    } else {
      mergeMappings(state, _result, valueNode, overridableKeys);
    }
  } else {
    if (!state.json && !_hasOwnProperty$1.call(overridableKeys, keyNode) && _hasOwnProperty$1.call(_result, keyNode)) {
      state.line = startLine || state.line;
      state.lineStart = startLineStart || state.lineStart;
      state.position = startPos || state.position;
      throwError(state, "duplicated mapping key");
    }
    setProperty(_result, keyNode, valueNode);
    delete overridableKeys[keyNode];
  }
  return _result;
}
function readLineBreak(state) {
  var ch;
  ch = state.input.charCodeAt(state.position);
  if (ch === 10) {
    state.position++;
  } else if (ch === 13) {
    state.position++;
    if (state.input.charCodeAt(state.position) === 10) {
      state.position++;
    }
  } else {
    throwError(state, "a line break is expected");
  }
  state.line += 1;
  state.lineStart = state.position;
  state.firstTabInLine = -1;
}
function skipSeparationSpace(state, allowComments, checkIndent) {
  var lineBreaks = 0, ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    while (is_WHITE_SPACE(ch)) {
      if (ch === 9 && state.firstTabInLine === -1) {
        state.firstTabInLine = state.position;
      }
      ch = state.input.charCodeAt(++state.position);
    }
    if (allowComments && ch === 35) {
      do {
        ch = state.input.charCodeAt(++state.position);
      } while (ch !== 10 && ch !== 13 && ch !== 0);
    }
    if (is_EOL(ch)) {
      readLineBreak(state);
      ch = state.input.charCodeAt(state.position);
      lineBreaks++;
      state.lineIndent = 0;
      while (ch === 32) {
        state.lineIndent++;
        ch = state.input.charCodeAt(++state.position);
      }
    } else {
      break;
    }
  }
  if (checkIndent !== -1 && lineBreaks !== 0 && state.lineIndent < checkIndent) {
    throwWarning(state, "deficient indentation");
  }
  return lineBreaks;
}
function testDocumentSeparator(state) {
  var _position = state.position, ch;
  ch = state.input.charCodeAt(_position);
  if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(_position + 1) && ch === state.input.charCodeAt(_position + 2)) {
    _position += 3;
    ch = state.input.charCodeAt(_position);
    if (ch === 0 || is_WS_OR_EOL(ch)) {
      return true;
    }
  }
  return false;
}
function writeFoldedLines(state, count) {
  if (count === 1) {
    state.result += " ";
  } else if (count > 1) {
    state.result += common.repeat("\n", count - 1);
  }
}
function readPlainScalar(state, nodeIndent, withinFlowCollection) {
  var preceding, following, captureStart, captureEnd, hasPendingContent, _line, _lineStart, _lineIndent, _kind = state.kind, _result = state.result, ch;
  ch = state.input.charCodeAt(state.position);
  if (is_WS_OR_EOL(ch) || is_FLOW_INDICATOR(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96) {
    return false;
  }
  if (ch === 63 || ch === 45) {
    following = state.input.charCodeAt(state.position + 1);
    if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
      return false;
    }
  }
  state.kind = "scalar";
  state.result = "";
  captureStart = captureEnd = state.position;
  hasPendingContent = false;
  while (ch !== 0) {
    if (ch === 58) {
      following = state.input.charCodeAt(state.position + 1);
      if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
        break;
      }
    } else if (ch === 35) {
      preceding = state.input.charCodeAt(state.position - 1);
      if (is_WS_OR_EOL(preceding)) {
        break;
      }
    } else if (state.position === state.lineStart && testDocumentSeparator(state) || withinFlowCollection && is_FLOW_INDICATOR(ch)) {
      break;
    } else if (is_EOL(ch)) {
      _line = state.line;
      _lineStart = state.lineStart;
      _lineIndent = state.lineIndent;
      skipSeparationSpace(state, false, -1);
      if (state.lineIndent >= nodeIndent) {
        hasPendingContent = true;
        ch = state.input.charCodeAt(state.position);
        continue;
      } else {
        state.position = captureEnd;
        state.line = _line;
        state.lineStart = _lineStart;
        state.lineIndent = _lineIndent;
        break;
      }
    }
    if (hasPendingContent) {
      captureSegment(state, captureStart, captureEnd, false);
      writeFoldedLines(state, state.line - _line);
      captureStart = captureEnd = state.position;
      hasPendingContent = false;
    }
    if (!is_WHITE_SPACE(ch)) {
      captureEnd = state.position + 1;
    }
    ch = state.input.charCodeAt(++state.position);
  }
  captureSegment(state, captureStart, captureEnd, false);
  if (state.result) {
    return true;
  }
  state.kind = _kind;
  state.result = _result;
  return false;
}
function readSingleQuotedScalar(state, nodeIndent) {
  var ch, captureStart, captureEnd;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 39) {
    return false;
  }
  state.kind = "scalar";
  state.result = "";
  state.position++;
  captureStart = captureEnd = state.position;
  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    if (ch === 39) {
      captureSegment(state, captureStart, state.position, true);
      ch = state.input.charCodeAt(++state.position);
      if (ch === 39) {
        captureStart = state.position;
        state.position++;
        captureEnd = state.position;
      } else {
        return true;
      }
    } else if (is_EOL(ch)) {
      captureSegment(state, captureStart, captureEnd, true);
      writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
      captureStart = captureEnd = state.position;
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
      throwError(state, "unexpected end of the document within a single quoted scalar");
    } else {
      state.position++;
      captureEnd = state.position;
    }
  }
  throwError(state, "unexpected end of the stream within a single quoted scalar");
}
function readDoubleQuotedScalar(state, nodeIndent) {
  var captureStart, captureEnd, hexLength, hexResult, tmp, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 34) {
    return false;
  }
  state.kind = "scalar";
  state.result = "";
  state.position++;
  captureStart = captureEnd = state.position;
  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    if (ch === 34) {
      captureSegment(state, captureStart, state.position, true);
      state.position++;
      return true;
    } else if (ch === 92) {
      captureSegment(state, captureStart, state.position, true);
      ch = state.input.charCodeAt(++state.position);
      if (is_EOL(ch)) {
        skipSeparationSpace(state, false, nodeIndent);
      } else if (ch < 256 && simpleEscapeCheck[ch]) {
        state.result += simpleEscapeMap[ch];
        state.position++;
      } else if ((tmp = escapedHexLen(ch)) > 0) {
        hexLength = tmp;
        hexResult = 0;
        for (; hexLength > 0; hexLength--) {
          ch = state.input.charCodeAt(++state.position);
          if ((tmp = fromHexCode(ch)) >= 0) {
            hexResult = (hexResult << 4) + tmp;
          } else {
            throwError(state, "expected hexadecimal character");
          }
        }
        state.result += charFromCodepoint(hexResult);
        state.position++;
      } else {
        throwError(state, "unknown escape sequence");
      }
      captureStart = captureEnd = state.position;
    } else if (is_EOL(ch)) {
      captureSegment(state, captureStart, captureEnd, true);
      writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
      captureStart = captureEnd = state.position;
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
      throwError(state, "unexpected end of the document within a double quoted scalar");
    } else {
      state.position++;
      captureEnd = state.position;
    }
  }
  throwError(state, "unexpected end of the stream within a double quoted scalar");
}
function readFlowCollection(state, nodeIndent) {
  var readNext = true, _line, _lineStart, _pos, _tag = state.tag, _result, _anchor = state.anchor, following, terminator, isPair, isExplicitPair, isMapping, overridableKeys = /* @__PURE__ */ Object.create(null), keyNode, keyTag, valueNode, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch === 91) {
    terminator = 93;
    isMapping = false;
    _result = [];
  } else if (ch === 123) {
    terminator = 125;
    isMapping = true;
    _result = {};
  } else {
    return false;
  }
  if (state.anchor !== null) {
    state.anchorMap[state.anchor] = _result;
  }
  ch = state.input.charCodeAt(++state.position);
  while (ch !== 0) {
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if (ch === terminator) {
      state.position++;
      state.tag = _tag;
      state.anchor = _anchor;
      state.kind = isMapping ? "mapping" : "sequence";
      state.result = _result;
      return true;
    } else if (!readNext) {
      throwError(state, "missed comma between flow collection entries");
    } else if (ch === 44) {
      throwError(state, "expected the node content, but found ','");
    }
    keyTag = keyNode = valueNode = null;
    isPair = isExplicitPair = false;
    if (ch === 63) {
      following = state.input.charCodeAt(state.position + 1);
      if (is_WS_OR_EOL(following)) {
        isPair = isExplicitPair = true;
        state.position++;
        skipSeparationSpace(state, true, nodeIndent);
      }
    }
    _line = state.line;
    _lineStart = state.lineStart;
    _pos = state.position;
    composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
    keyTag = state.tag;
    keyNode = state.result;
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if ((isExplicitPair || state.line === _line) && ch === 58) {
      isPair = true;
      ch = state.input.charCodeAt(++state.position);
      skipSeparationSpace(state, true, nodeIndent);
      composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
      valueNode = state.result;
    }
    if (isMapping) {
      storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos);
    } else if (isPair) {
      _result.push(storeMappingPair(state, null, overridableKeys, keyTag, keyNode, valueNode, _line, _lineStart, _pos));
    } else {
      _result.push(keyNode);
    }
    skipSeparationSpace(state, true, nodeIndent);
    ch = state.input.charCodeAt(state.position);
    if (ch === 44) {
      readNext = true;
      ch = state.input.charCodeAt(++state.position);
    } else {
      readNext = false;
    }
  }
  throwError(state, "unexpected end of the stream within a flow collection");
}
function readBlockScalar(state, nodeIndent) {
  var captureStart, folding, chomping = CHOMPING_CLIP, didReadContent = false, detectedIndent = false, textIndent = nodeIndent, emptyLines = 0, atMoreIndented = false, tmp, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch === 124) {
    folding = false;
  } else if (ch === 62) {
    folding = true;
  } else {
    return false;
  }
  state.kind = "scalar";
  state.result = "";
  while (ch !== 0) {
    ch = state.input.charCodeAt(++state.position);
    if (ch === 43 || ch === 45) {
      if (CHOMPING_CLIP === chomping) {
        chomping = ch === 43 ? CHOMPING_KEEP : CHOMPING_STRIP;
      } else {
        throwError(state, "repeat of a chomping mode identifier");
      }
    } else if ((tmp = fromDecimalCode(ch)) >= 0) {
      if (tmp === 0) {
        throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
      } else if (!detectedIndent) {
        textIndent = nodeIndent + tmp - 1;
        detectedIndent = true;
      } else {
        throwError(state, "repeat of an indentation width identifier");
      }
    } else {
      break;
    }
  }
  if (is_WHITE_SPACE(ch)) {
    do {
      ch = state.input.charCodeAt(++state.position);
    } while (is_WHITE_SPACE(ch));
    if (ch === 35) {
      do {
        ch = state.input.charCodeAt(++state.position);
      } while (!is_EOL(ch) && ch !== 0);
    }
  }
  while (ch !== 0) {
    readLineBreak(state);
    state.lineIndent = 0;
    ch = state.input.charCodeAt(state.position);
    while ((!detectedIndent || state.lineIndent < textIndent) && ch === 32) {
      state.lineIndent++;
      ch = state.input.charCodeAt(++state.position);
    }
    if (!detectedIndent && state.lineIndent > textIndent) {
      textIndent = state.lineIndent;
    }
    if (is_EOL(ch)) {
      emptyLines++;
      continue;
    }
    if (state.lineIndent < textIndent) {
      if (chomping === CHOMPING_KEEP) {
        state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
      } else if (chomping === CHOMPING_CLIP) {
        if (didReadContent) {
          state.result += "\n";
        }
      }
      break;
    }
    if (folding) {
      if (is_WHITE_SPACE(ch)) {
        atMoreIndented = true;
        state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
      } else if (atMoreIndented) {
        atMoreIndented = false;
        state.result += common.repeat("\n", emptyLines + 1);
      } else if (emptyLines === 0) {
        if (didReadContent) {
          state.result += " ";
        }
      } else {
        state.result += common.repeat("\n", emptyLines);
      }
    } else {
      state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
    }
    didReadContent = true;
    detectedIndent = true;
    emptyLines = 0;
    captureStart = state.position;
    while (!is_EOL(ch) && ch !== 0) {
      ch = state.input.charCodeAt(++state.position);
    }
    captureSegment(state, captureStart, state.position, false);
  }
  return true;
}
function readBlockSequence(state, nodeIndent) {
  var _line, _tag = state.tag, _anchor = state.anchor, _result = [], following, detected = false, ch;
  if (state.firstTabInLine !== -1) return false;
  if (state.anchor !== null) {
    state.anchorMap[state.anchor] = _result;
  }
  ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    if (ch !== 45) {
      break;
    }
    following = state.input.charCodeAt(state.position + 1);
    if (!is_WS_OR_EOL(following)) {
      break;
    }
    detected = true;
    state.position++;
    if (skipSeparationSpace(state, true, -1)) {
      if (state.lineIndent <= nodeIndent) {
        _result.push(null);
        ch = state.input.charCodeAt(state.position);
        continue;
      }
    }
    _line = state.line;
    composeNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
    _result.push(state.result);
    skipSeparationSpace(state, true, -1);
    ch = state.input.charCodeAt(state.position);
    if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) {
      throwError(state, "bad indentation of a sequence entry");
    } else if (state.lineIndent < nodeIndent) {
      break;
    }
  }
  if (detected) {
    state.tag = _tag;
    state.anchor = _anchor;
    state.kind = "sequence";
    state.result = _result;
    return true;
  }
  return false;
}
function readBlockMapping(state, nodeIndent, flowIndent) {
  var following, allowCompact, _line, _keyLine, _keyLineStart, _keyPos, _tag = state.tag, _anchor = state.anchor, _result = {}, overridableKeys = /* @__PURE__ */ Object.create(null), keyTag = null, keyNode = null, valueNode = null, atExplicitKey = false, detected = false, ch;
  if (state.firstTabInLine !== -1) return false;
  if (state.anchor !== null) {
    state.anchorMap[state.anchor] = _result;
  }
  ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (!atExplicitKey && state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    following = state.input.charCodeAt(state.position + 1);
    _line = state.line;
    if ((ch === 63 || ch === 58) && is_WS_OR_EOL(following)) {
      if (ch === 63) {
        if (atExplicitKey) {
          storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
          keyTag = keyNode = valueNode = null;
        }
        detected = true;
        atExplicitKey = true;
        allowCompact = true;
      } else if (atExplicitKey) {
        atExplicitKey = false;
        allowCompact = true;
      } else {
        throwError(state, "incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line");
      }
      state.position += 1;
      ch = following;
    } else {
      _keyLine = state.line;
      _keyLineStart = state.lineStart;
      _keyPos = state.position;
      if (!composeNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) {
        break;
      }
      if (state.line === _line) {
        ch = state.input.charCodeAt(state.position);
        while (is_WHITE_SPACE(ch)) {
          ch = state.input.charCodeAt(++state.position);
        }
        if (ch === 58) {
          ch = state.input.charCodeAt(++state.position);
          if (!is_WS_OR_EOL(ch)) {
            throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
          }
          if (atExplicitKey) {
            storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
            keyTag = keyNode = valueNode = null;
          }
          detected = true;
          atExplicitKey = false;
          allowCompact = false;
          keyTag = state.tag;
          keyNode = state.result;
        } else if (detected) {
          throwError(state, "can not read an implicit mapping pair; a colon is missed");
        } else {
          state.tag = _tag;
          state.anchor = _anchor;
          return true;
        }
      } else if (detected) {
        throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
      } else {
        state.tag = _tag;
        state.anchor = _anchor;
        return true;
      }
    }
    if (state.line === _line || state.lineIndent > nodeIndent) {
      if (atExplicitKey) {
        _keyLine = state.line;
        _keyLineStart = state.lineStart;
        _keyPos = state.position;
      }
      if (composeNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, allowCompact)) {
        if (atExplicitKey) {
          keyNode = state.result;
        } else {
          valueNode = state.result;
        }
      }
      if (!atExplicitKey) {
        storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _keyLine, _keyLineStart, _keyPos);
        keyTag = keyNode = valueNode = null;
      }
      skipSeparationSpace(state, true, -1);
      ch = state.input.charCodeAt(state.position);
    }
    if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) {
      throwError(state, "bad indentation of a mapping entry");
    } else if (state.lineIndent < nodeIndent) {
      break;
    }
  }
  if (atExplicitKey) {
    storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null, _keyLine, _keyLineStart, _keyPos);
  }
  if (detected) {
    state.tag = _tag;
    state.anchor = _anchor;
    state.kind = "mapping";
    state.result = _result;
  }
  return detected;
}
function readTagProperty(state) {
  var _position, isVerbatim = false, isNamed = false, tagHandle, tagName, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 33) return false;
  if (state.tag !== null) {
    throwError(state, "duplication of a tag property");
  }
  ch = state.input.charCodeAt(++state.position);
  if (ch === 60) {
    isVerbatim = true;
    ch = state.input.charCodeAt(++state.position);
  } else if (ch === 33) {
    isNamed = true;
    tagHandle = "!!";
    ch = state.input.charCodeAt(++state.position);
  } else {
    tagHandle = "!";
  }
  _position = state.position;
  if (isVerbatim) {
    do {
      ch = state.input.charCodeAt(++state.position);
    } while (ch !== 0 && ch !== 62);
    if (state.position < state.length) {
      tagName = state.input.slice(_position, state.position);
      ch = state.input.charCodeAt(++state.position);
    } else {
      throwError(state, "unexpected end of the stream within a verbatim tag");
    }
  } else {
    while (ch !== 0 && !is_WS_OR_EOL(ch)) {
      if (ch === 33) {
        if (!isNamed) {
          tagHandle = state.input.slice(_position - 1, state.position + 1);
          if (!PATTERN_TAG_HANDLE.test(tagHandle)) {
            throwError(state, "named tag handle cannot contain such characters");
          }
          isNamed = true;
          _position = state.position + 1;
        } else {
          throwError(state, "tag suffix cannot contain exclamation marks");
        }
      }
      ch = state.input.charCodeAt(++state.position);
    }
    tagName = state.input.slice(_position, state.position);
    if (PATTERN_FLOW_INDICATORS.test(tagName)) {
      throwError(state, "tag suffix cannot contain flow indicator characters");
    }
  }
  if (tagName && !PATTERN_TAG_URI.test(tagName)) {
    throwError(state, "tag name cannot contain such characters: " + tagName);
  }
  try {
    tagName = decodeURIComponent(tagName);
  } catch (err) {
    throwError(state, "tag name is malformed: " + tagName);
  }
  if (isVerbatim) {
    state.tag = tagName;
  } else if (_hasOwnProperty$1.call(state.tagMap, tagHandle)) {
    state.tag = state.tagMap[tagHandle] + tagName;
  } else if (tagHandle === "!") {
    state.tag = "!" + tagName;
  } else if (tagHandle === "!!") {
    state.tag = "tag:yaml.org,2002:" + tagName;
  } else {
    throwError(state, 'undeclared tag handle "' + tagHandle + '"');
  }
  return true;
}
function readAnchorProperty(state) {
  var _position, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 38) return false;
  if (state.anchor !== null) {
    throwError(state, "duplication of an anchor property");
  }
  ch = state.input.charCodeAt(++state.position);
  _position = state.position;
  while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
    ch = state.input.charCodeAt(++state.position);
  }
  if (state.position === _position) {
    throwError(state, "name of an anchor node must contain at least one character");
  }
  state.anchor = state.input.slice(_position, state.position);
  return true;
}
function readAlias(state) {
  var _position, alias, ch;
  ch = state.input.charCodeAt(state.position);
  if (ch !== 42) return false;
  ch = state.input.charCodeAt(++state.position);
  _position = state.position;
  while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
    ch = state.input.charCodeAt(++state.position);
  }
  if (state.position === _position) {
    throwError(state, "name of an alias node must contain at least one character");
  }
  alias = state.input.slice(_position, state.position);
  if (!_hasOwnProperty$1.call(state.anchorMap, alias)) {
    throwError(state, 'unidentified alias "' + alias + '"');
  }
  state.result = state.anchorMap[alias];
  skipSeparationSpace(state, true, -1);
  return true;
}
function composeNode(state, parentIndent, nodeContext, allowToSeek, allowCompact) {
  var allowBlockStyles, allowBlockScalars, allowBlockCollections, indentStatus = 1, atNewLine = false, hasContent = false, typeIndex, typeQuantity, typeList, type2, flowIndent, blockIndent;
  if (state.listener !== null) {
    state.listener("open", state);
  }
  state.tag = null;
  state.anchor = null;
  state.kind = null;
  state.result = null;
  allowBlockStyles = allowBlockScalars = allowBlockCollections = CONTEXT_BLOCK_OUT === nodeContext || CONTEXT_BLOCK_IN === nodeContext;
  if (allowToSeek) {
    if (skipSeparationSpace(state, true, -1)) {
      atNewLine = true;
      if (state.lineIndent > parentIndent) {
        indentStatus = 1;
      } else if (state.lineIndent === parentIndent) {
        indentStatus = 0;
      } else if (state.lineIndent < parentIndent) {
        indentStatus = -1;
      }
    }
  }
  if (indentStatus === 1) {
    while (readTagProperty(state) || readAnchorProperty(state)) {
      if (skipSeparationSpace(state, true, -1)) {
        atNewLine = true;
        allowBlockCollections = allowBlockStyles;
        if (state.lineIndent > parentIndent) {
          indentStatus = 1;
        } else if (state.lineIndent === parentIndent) {
          indentStatus = 0;
        } else if (state.lineIndent < parentIndent) {
          indentStatus = -1;
        }
      } else {
        allowBlockCollections = false;
      }
    }
  }
  if (allowBlockCollections) {
    allowBlockCollections = atNewLine || allowCompact;
  }
  if (indentStatus === 1 || CONTEXT_BLOCK_OUT === nodeContext) {
    if (CONTEXT_FLOW_IN === nodeContext || CONTEXT_FLOW_OUT === nodeContext) {
      flowIndent = parentIndent;
    } else {
      flowIndent = parentIndent + 1;
    }
    blockIndent = state.position - state.lineStart;
    if (indentStatus === 1) {
      if (allowBlockCollections && (readBlockSequence(state, blockIndent) || readBlockMapping(state, blockIndent, flowIndent)) || readFlowCollection(state, flowIndent)) {
        hasContent = true;
      } else {
        if (allowBlockScalars && readBlockScalar(state, flowIndent) || readSingleQuotedScalar(state, flowIndent) || readDoubleQuotedScalar(state, flowIndent)) {
          hasContent = true;
        } else if (readAlias(state)) {
          hasContent = true;
          if (state.tag !== null || state.anchor !== null) {
            throwError(state, "alias node should not have any properties");
          }
        } else if (readPlainScalar(state, flowIndent, CONTEXT_FLOW_IN === nodeContext)) {
          hasContent = true;
          if (state.tag === null) {
            state.tag = "?";
          }
        }
        if (state.anchor !== null) {
          state.anchorMap[state.anchor] = state.result;
        }
      }
    } else if (indentStatus === 0) {
      hasContent = allowBlockCollections && readBlockSequence(state, blockIndent);
    }
  }
  if (state.tag === null) {
    if (state.anchor !== null) {
      state.anchorMap[state.anchor] = state.result;
    }
  } else if (state.tag === "?") {
    if (state.result !== null && state.kind !== "scalar") {
      throwError(state, 'unacceptable node kind for !<?> tag; it should be "scalar", not "' + state.kind + '"');
    }
    for (typeIndex = 0, typeQuantity = state.implicitTypes.length; typeIndex < typeQuantity; typeIndex += 1) {
      type2 = state.implicitTypes[typeIndex];
      if (type2.resolve(state.result)) {
        state.result = type2.construct(state.result);
        state.tag = type2.tag;
        if (state.anchor !== null) {
          state.anchorMap[state.anchor] = state.result;
        }
        break;
      }
    }
  } else if (state.tag !== "!") {
    if (_hasOwnProperty$1.call(state.typeMap[state.kind || "fallback"], state.tag)) {
      type2 = state.typeMap[state.kind || "fallback"][state.tag];
    } else {
      type2 = null;
      typeList = state.typeMap.multi[state.kind || "fallback"];
      for (typeIndex = 0, typeQuantity = typeList.length; typeIndex < typeQuantity; typeIndex += 1) {
        if (state.tag.slice(0, typeList[typeIndex].tag.length) === typeList[typeIndex].tag) {
          type2 = typeList[typeIndex];
          break;
        }
      }
    }
    if (!type2) {
      throwError(state, "unknown tag !<" + state.tag + ">");
    }
    if (state.result !== null && type2.kind !== state.kind) {
      throwError(state, "unacceptable node kind for !<" + state.tag + '> tag; it should be "' + type2.kind + '", not "' + state.kind + '"');
    }
    if (!type2.resolve(state.result, state.tag)) {
      throwError(state, "cannot resolve a node with !<" + state.tag + "> explicit tag");
    } else {
      state.result = type2.construct(state.result, state.tag);
      if (state.anchor !== null) {
        state.anchorMap[state.anchor] = state.result;
      }
    }
  }
  if (state.listener !== null) {
    state.listener("close", state);
  }
  return state.tag !== null || state.anchor !== null || hasContent;
}
function readDocument(state) {
  var documentStart = state.position, _position, directiveName, directiveArgs, hasDirectives = false, ch;
  state.version = null;
  state.checkLineBreaks = state.legacy;
  state.tagMap = /* @__PURE__ */ Object.create(null);
  state.anchorMap = /* @__PURE__ */ Object.create(null);
  while ((ch = state.input.charCodeAt(state.position)) !== 0) {
    skipSeparationSpace(state, true, -1);
    ch = state.input.charCodeAt(state.position);
    if (state.lineIndent > 0 || ch !== 37) {
      break;
    }
    hasDirectives = true;
    ch = state.input.charCodeAt(++state.position);
    _position = state.position;
    while (ch !== 0 && !is_WS_OR_EOL(ch)) {
      ch = state.input.charCodeAt(++state.position);
    }
    directiveName = state.input.slice(_position, state.position);
    directiveArgs = [];
    if (directiveName.length < 1) {
      throwError(state, "directive name must not be less than one character in length");
    }
    while (ch !== 0) {
      while (is_WHITE_SPACE(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }
      if (ch === 35) {
        do {
          ch = state.input.charCodeAt(++state.position);
        } while (ch !== 0 && !is_EOL(ch));
        break;
      }
      if (is_EOL(ch)) break;
      _position = state.position;
      while (ch !== 0 && !is_WS_OR_EOL(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }
      directiveArgs.push(state.input.slice(_position, state.position));
    }
    if (ch !== 0) readLineBreak(state);
    if (_hasOwnProperty$1.call(directiveHandlers, directiveName)) {
      directiveHandlers[directiveName](state, directiveName, directiveArgs);
    } else {
      throwWarning(state, 'unknown document directive "' + directiveName + '"');
    }
  }
  skipSeparationSpace(state, true, -1);
  if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45) {
    state.position += 3;
    skipSeparationSpace(state, true, -1);
  } else if (hasDirectives) {
    throwError(state, "directives end mark is expected");
  }
  composeNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, true);
  skipSeparationSpace(state, true, -1);
  if (state.checkLineBreaks && PATTERN_NON_ASCII_LINE_BREAKS.test(state.input.slice(documentStart, state.position))) {
    throwWarning(state, "non-ASCII line breaks are interpreted as content");
  }
  state.documents.push(state.result);
  if (state.position === state.lineStart && testDocumentSeparator(state)) {
    if (state.input.charCodeAt(state.position) === 46) {
      state.position += 3;
      skipSeparationSpace(state, true, -1);
    }
    return;
  }
  if (state.position < state.length - 1) {
    throwError(state, "end of the stream or a document separator is expected");
  } else {
    return;
  }
}
function loadDocuments(input, options) {
  input = String(input);
  options = options || {};
  if (input.length !== 0) {
    if (input.charCodeAt(input.length - 1) !== 10 && input.charCodeAt(input.length - 1) !== 13) {
      input += "\n";
    }
    if (input.charCodeAt(0) === 65279) {
      input = input.slice(1);
    }
  }
  var state = new State$1(input, options);
  var nullpos = input.indexOf("\0");
  if (nullpos !== -1) {
    state.position = nullpos;
    throwError(state, "null byte is not allowed in input");
  }
  state.input += "\0";
  while (state.input.charCodeAt(state.position) === 32) {
    state.lineIndent += 1;
    state.position += 1;
  }
  while (state.position < state.length - 1) {
    readDocument(state);
  }
  return state.documents;
}
function loadAll$1(input, iterator, options) {
  if (iterator !== null && typeof iterator === "object" && typeof options === "undefined") {
    options = iterator;
    iterator = null;
  }
  var documents = loadDocuments(input, options);
  if (typeof iterator !== "function") {
    return documents;
  }
  for (var index = 0, length = documents.length; index < length; index += 1) {
    iterator(documents[index]);
  }
}
function load$1(input, options) {
  var documents = loadDocuments(input, options);
  if (documents.length === 0) {
    return void 0;
  } else if (documents.length === 1) {
    return documents[0];
  }
  throw new exception("expected a single document in the stream, but found more");
}
var loadAll_1 = loadAll$1;
var load_1 = load$1;
var loader = {
  loadAll: loadAll_1,
  load: load_1
};
var _toString = Object.prototype.toString;
var _hasOwnProperty = Object.prototype.hasOwnProperty;
var CHAR_BOM = 65279;
var CHAR_TAB = 9;
var CHAR_LINE_FEED = 10;
var CHAR_CARRIAGE_RETURN = 13;
var CHAR_SPACE = 32;
var CHAR_EXCLAMATION = 33;
var CHAR_DOUBLE_QUOTE = 34;
var CHAR_SHARP = 35;
var CHAR_PERCENT = 37;
var CHAR_AMPERSAND = 38;
var CHAR_SINGLE_QUOTE = 39;
var CHAR_ASTERISK = 42;
var CHAR_COMMA = 44;
var CHAR_MINUS = 45;
var CHAR_COLON = 58;
var CHAR_EQUALS = 61;
var CHAR_GREATER_THAN = 62;
var CHAR_QUESTION = 63;
var CHAR_COMMERCIAL_AT = 64;
var CHAR_LEFT_SQUARE_BRACKET = 91;
var CHAR_RIGHT_SQUARE_BRACKET = 93;
var CHAR_GRAVE_ACCENT = 96;
var CHAR_LEFT_CURLY_BRACKET = 123;
var CHAR_VERTICAL_LINE = 124;
var CHAR_RIGHT_CURLY_BRACKET = 125;
var ESCAPE_SEQUENCES = {};
ESCAPE_SEQUENCES[0] = "\\0";
ESCAPE_SEQUENCES[7] = "\\a";
ESCAPE_SEQUENCES[8] = "\\b";
ESCAPE_SEQUENCES[9] = "\\t";
ESCAPE_SEQUENCES[10] = "\\n";
ESCAPE_SEQUENCES[11] = "\\v";
ESCAPE_SEQUENCES[12] = "\\f";
ESCAPE_SEQUENCES[13] = "\\r";
ESCAPE_SEQUENCES[27] = "\\e";
ESCAPE_SEQUENCES[34] = '\\"';
ESCAPE_SEQUENCES[92] = "\\\\";
ESCAPE_SEQUENCES[133] = "\\N";
ESCAPE_SEQUENCES[160] = "\\_";
ESCAPE_SEQUENCES[8232] = "\\L";
ESCAPE_SEQUENCES[8233] = "\\P";
var DEPRECATED_BOOLEANS_SYNTAX = [
  "y",
  "Y",
  "yes",
  "Yes",
  "YES",
  "on",
  "On",
  "ON",
  "n",
  "N",
  "no",
  "No",
  "NO",
  "off",
  "Off",
  "OFF"
];
var DEPRECATED_BASE60_SYNTAX = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/;
function compileStyleMap(schema2, map2) {
  var result, keys, index, length, tag, style, type2;
  if (map2 === null) return {};
  result = {};
  keys = Object.keys(map2);
  for (index = 0, length = keys.length; index < length; index += 1) {
    tag = keys[index];
    style = String(map2[tag]);
    if (tag.slice(0, 2) === "!!") {
      tag = "tag:yaml.org,2002:" + tag.slice(2);
    }
    type2 = schema2.compiledTypeMap["fallback"][tag];
    if (type2 && _hasOwnProperty.call(type2.styleAliases, style)) {
      style = type2.styleAliases[style];
    }
    result[tag] = style;
  }
  return result;
}
function encodeHex(character) {
  var string, handle, length;
  string = character.toString(16).toUpperCase();
  if (character <= 255) {
    handle = "x";
    length = 2;
  } else if (character <= 65535) {
    handle = "u";
    length = 4;
  } else if (character <= 4294967295) {
    handle = "U";
    length = 8;
  } else {
    throw new exception("code point within a string may not be greater than 0xFFFFFFFF");
  }
  return "\\" + handle + common.repeat("0", length - string.length) + string;
}
var QUOTING_TYPE_SINGLE = 1, QUOTING_TYPE_DOUBLE = 2;
function State(options) {
  this.schema = options["schema"] || _default;
  this.indent = Math.max(1, options["indent"] || 2);
  this.noArrayIndent = options["noArrayIndent"] || false;
  this.skipInvalid = options["skipInvalid"] || false;
  this.flowLevel = common.isNothing(options["flowLevel"]) ? -1 : options["flowLevel"];
  this.styleMap = compileStyleMap(this.schema, options["styles"] || null);
  this.sortKeys = options["sortKeys"] || false;
  this.lineWidth = options["lineWidth"] || 80;
  this.noRefs = options["noRefs"] || false;
  this.noCompatMode = options["noCompatMode"] || false;
  this.condenseFlow = options["condenseFlow"] || false;
  this.quotingType = options["quotingType"] === '"' ? QUOTING_TYPE_DOUBLE : QUOTING_TYPE_SINGLE;
  this.forceQuotes = options["forceQuotes"] || false;
  this.replacer = typeof options["replacer"] === "function" ? options["replacer"] : null;
  this.implicitTypes = this.schema.compiledImplicit;
  this.explicitTypes = this.schema.compiledExplicit;
  this.tag = null;
  this.result = "";
  this.duplicates = [];
  this.usedDuplicates = null;
}
function indentString(string, spaces) {
  var ind = common.repeat(" ", spaces), position = 0, next = -1, result = "", line, length = string.length;
  while (position < length) {
    next = string.indexOf("\n", position);
    if (next === -1) {
      line = string.slice(position);
      position = length;
    } else {
      line = string.slice(position, next + 1);
      position = next + 1;
    }
    if (line.length && line !== "\n") result += ind;
    result += line;
  }
  return result;
}
function generateNextLine(state, level) {
  return "\n" + common.repeat(" ", state.indent * level);
}
function testImplicitResolving(state, str2) {
  var index, length, type2;
  for (index = 0, length = state.implicitTypes.length; index < length; index += 1) {
    type2 = state.implicitTypes[index];
    if (type2.resolve(str2)) {
      return true;
    }
  }
  return false;
}
function isWhitespace(c) {
  return c === CHAR_SPACE || c === CHAR_TAB;
}
function isPrintable(c) {
  return 32 <= c && c <= 126 || 161 <= c && c <= 55295 && c !== 8232 && c !== 8233 || 57344 <= c && c <= 65533 && c !== CHAR_BOM || 65536 <= c && c <= 1114111;
}
function isNsCharOrWhitespace(c) {
  return isPrintable(c) && c !== CHAR_BOM && c !== CHAR_CARRIAGE_RETURN && c !== CHAR_LINE_FEED;
}
function isPlainSafe(c, prev, inblock) {
  var cIsNsCharOrWhitespace = isNsCharOrWhitespace(c);
  var cIsNsChar = cIsNsCharOrWhitespace && !isWhitespace(c);
  return (
    // ns-plain-safe
    (inblock ? (
      // c = flow-in
      cIsNsCharOrWhitespace
    ) : cIsNsCharOrWhitespace && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET) && c !== CHAR_SHARP && !(prev === CHAR_COLON && !cIsNsChar) || isNsCharOrWhitespace(prev) && !isWhitespace(prev) && c === CHAR_SHARP || prev === CHAR_COLON && cIsNsChar
  );
}
function isPlainSafeFirst(c) {
  return isPrintable(c) && c !== CHAR_BOM && !isWhitespace(c) && c !== CHAR_MINUS && c !== CHAR_QUESTION && c !== CHAR_COLON && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET && c !== CHAR_SHARP && c !== CHAR_AMPERSAND && c !== CHAR_ASTERISK && c !== CHAR_EXCLAMATION && c !== CHAR_VERTICAL_LINE && c !== CHAR_EQUALS && c !== CHAR_GREATER_THAN && c !== CHAR_SINGLE_QUOTE && c !== CHAR_DOUBLE_QUOTE && c !== CHAR_PERCENT && c !== CHAR_COMMERCIAL_AT && c !== CHAR_GRAVE_ACCENT;
}
function isPlainSafeLast(c) {
  return !isWhitespace(c) && c !== CHAR_COLON;
}
function codePointAt(string, pos) {
  var first = string.charCodeAt(pos), second;
  if (first >= 55296 && first <= 56319 && pos + 1 < string.length) {
    second = string.charCodeAt(pos + 1);
    if (second >= 56320 && second <= 57343) {
      return (first - 55296) * 1024 + second - 56320 + 65536;
    }
  }
  return first;
}
function needIndentIndicator(string) {
  var leadingSpaceRe = /^\n* /;
  return leadingSpaceRe.test(string);
}
var STYLE_PLAIN = 1, STYLE_SINGLE = 2, STYLE_LITERAL = 3, STYLE_FOLDED = 4, STYLE_DOUBLE = 5;
function chooseScalarStyle(string, singleLineOnly, indentPerLevel, lineWidth, testAmbiguousType, quotingType, forceQuotes, inblock) {
  var i;
  var char = 0;
  var prevChar = null;
  var hasLineBreak = false;
  var hasFoldableLine = false;
  var shouldTrackWidth = lineWidth !== -1;
  var previousLineBreak = -1;
  var plain = isPlainSafeFirst(codePointAt(string, 0)) && isPlainSafeLast(codePointAt(string, string.length - 1));
  if (singleLineOnly || forceQuotes) {
    for (i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
      char = codePointAt(string, i);
      if (!isPrintable(char)) {
        return STYLE_DOUBLE;
      }
      plain = plain && isPlainSafe(char, prevChar, inblock);
      prevChar = char;
    }
  } else {
    for (i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
      char = codePointAt(string, i);
      if (char === CHAR_LINE_FEED) {
        hasLineBreak = true;
        if (shouldTrackWidth) {
          hasFoldableLine = hasFoldableLine || // Foldable line = too long, and not more-indented.
          i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ";
          previousLineBreak = i;
        }
      } else if (!isPrintable(char)) {
        return STYLE_DOUBLE;
      }
      plain = plain && isPlainSafe(char, prevChar, inblock);
      prevChar = char;
    }
    hasFoldableLine = hasFoldableLine || shouldTrackWidth && (i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ");
  }
  if (!hasLineBreak && !hasFoldableLine) {
    if (plain && !forceQuotes && !testAmbiguousType(string)) {
      return STYLE_PLAIN;
    }
    return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
  }
  if (indentPerLevel > 9 && needIndentIndicator(string)) {
    return STYLE_DOUBLE;
  }
  if (!forceQuotes) {
    return hasFoldableLine ? STYLE_FOLDED : STYLE_LITERAL;
  }
  return quotingType === QUOTING_TYPE_DOUBLE ? STYLE_DOUBLE : STYLE_SINGLE;
}
function writeScalar(state, string, level, iskey, inblock) {
  state.dump = (function() {
    if (string.length === 0) {
      return state.quotingType === QUOTING_TYPE_DOUBLE ? '""' : "''";
    }
    if (!state.noCompatMode) {
      if (DEPRECATED_BOOLEANS_SYNTAX.indexOf(string) !== -1 || DEPRECATED_BASE60_SYNTAX.test(string)) {
        return state.quotingType === QUOTING_TYPE_DOUBLE ? '"' + string + '"' : "'" + string + "'";
      }
    }
    var indent = state.indent * Math.max(1, level);
    var lineWidth = state.lineWidth === -1 ? -1 : Math.max(Math.min(state.lineWidth, 40), state.lineWidth - indent);
    var singleLineOnly = iskey || state.flowLevel > -1 && level >= state.flowLevel;
    function testAmbiguity(string2) {
      return testImplicitResolving(state, string2);
    }
    switch (chooseScalarStyle(
      string,
      singleLineOnly,
      state.indent,
      lineWidth,
      testAmbiguity,
      state.quotingType,
      state.forceQuotes && !iskey,
      inblock
    )) {
      case STYLE_PLAIN:
        return string;
      case STYLE_SINGLE:
        return "'" + string.replace(/'/g, "''") + "'";
      case STYLE_LITERAL:
        return "|" + blockHeader(string, state.indent) + dropEndingNewline(indentString(string, indent));
      case STYLE_FOLDED:
        return ">" + blockHeader(string, state.indent) + dropEndingNewline(indentString(foldString(string, lineWidth), indent));
      case STYLE_DOUBLE:
        return '"' + escapeString(string) + '"';
      default:
        throw new exception("impossible error: invalid scalar style");
    }
  })();
}
function blockHeader(string, indentPerLevel) {
  var indentIndicator = needIndentIndicator(string) ? String(indentPerLevel) : "";
  var clip = string[string.length - 1] === "\n";
  var keep = clip && (string[string.length - 2] === "\n" || string === "\n");
  var chomp = keep ? "+" : clip ? "" : "-";
  return indentIndicator + chomp + "\n";
}
function dropEndingNewline(string) {
  return string[string.length - 1] === "\n" ? string.slice(0, -1) : string;
}
function foldString(string, width) {
  var lineRe = /(\n+)([^\n]*)/g;
  var result = (function() {
    var nextLF = string.indexOf("\n");
    nextLF = nextLF !== -1 ? nextLF : string.length;
    lineRe.lastIndex = nextLF;
    return foldLine(string.slice(0, nextLF), width);
  })();
  var prevMoreIndented = string[0] === "\n" || string[0] === " ";
  var moreIndented;
  var match;
  while (match = lineRe.exec(string)) {
    var prefix = match[1], line = match[2];
    moreIndented = line[0] === " ";
    result += prefix + (!prevMoreIndented && !moreIndented && line !== "" ? "\n" : "") + foldLine(line, width);
    prevMoreIndented = moreIndented;
  }
  return result;
}
function foldLine(line, width) {
  if (line === "" || line[0] === " ") return line;
  var breakRe = / [^ ]/g;
  var match;
  var start = 0, end, curr = 0, next = 0;
  var result = "";
  while (match = breakRe.exec(line)) {
    next = match.index;
    if (next - start > width) {
      end = curr > start ? curr : next;
      result += "\n" + line.slice(start, end);
      start = end + 1;
    }
    curr = next;
  }
  result += "\n";
  if (line.length - start > width && curr > start) {
    result += line.slice(start, curr) + "\n" + line.slice(curr + 1);
  } else {
    result += line.slice(start);
  }
  return result.slice(1);
}
function escapeString(string) {
  var result = "";
  var char = 0;
  var escapeSeq;
  for (var i = 0; i < string.length; char >= 65536 ? i += 2 : i++) {
    char = codePointAt(string, i);
    escapeSeq = ESCAPE_SEQUENCES[char];
    if (!escapeSeq && isPrintable(char)) {
      result += string[i];
      if (char >= 65536) result += string[i + 1];
    } else {
      result += escapeSeq || encodeHex(char);
    }
  }
  return result;
}
function writeFlowSequence(state, level, object) {
  var _result = "", _tag = state.tag, index, length, value;
  for (index = 0, length = object.length; index < length; index += 1) {
    value = object[index];
    if (state.replacer) {
      value = state.replacer.call(object, String(index), value);
    }
    if (writeNode(state, level, value, false, false) || typeof value === "undefined" && writeNode(state, level, null, false, false)) {
      if (_result !== "") _result += "," + (!state.condenseFlow ? " " : "");
      _result += state.dump;
    }
  }
  state.tag = _tag;
  state.dump = "[" + _result + "]";
}
function writeBlockSequence(state, level, object, compact) {
  var _result = "", _tag = state.tag, index, length, value;
  for (index = 0, length = object.length; index < length; index += 1) {
    value = object[index];
    if (state.replacer) {
      value = state.replacer.call(object, String(index), value);
    }
    if (writeNode(state, level + 1, value, true, true, false, true) || typeof value === "undefined" && writeNode(state, level + 1, null, true, true, false, true)) {
      if (!compact || _result !== "") {
        _result += generateNextLine(state, level);
      }
      if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
        _result += "-";
      } else {
        _result += "- ";
      }
      _result += state.dump;
    }
  }
  state.tag = _tag;
  state.dump = _result || "[]";
}
function writeFlowMapping(state, level, object) {
  var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, pairBuffer;
  for (index = 0, length = objectKeyList.length; index < length; index += 1) {
    pairBuffer = "";
    if (_result !== "") pairBuffer += ", ";
    if (state.condenseFlow) pairBuffer += '"';
    objectKey = objectKeyList[index];
    objectValue = object[objectKey];
    if (state.replacer) {
      objectValue = state.replacer.call(object, objectKey, objectValue);
    }
    if (!writeNode(state, level, objectKey, false, false)) {
      continue;
    }
    if (state.dump.length > 1024) pairBuffer += "? ";
    pairBuffer += state.dump + (state.condenseFlow ? '"' : "") + ":" + (state.condenseFlow ? "" : " ");
    if (!writeNode(state, level, objectValue, false, false)) {
      continue;
    }
    pairBuffer += state.dump;
    _result += pairBuffer;
  }
  state.tag = _tag;
  state.dump = "{" + _result + "}";
}
function writeBlockMapping(state, level, object, compact) {
  var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, explicitPair, pairBuffer;
  if (state.sortKeys === true) {
    objectKeyList.sort();
  } else if (typeof state.sortKeys === "function") {
    objectKeyList.sort(state.sortKeys);
  } else if (state.sortKeys) {
    throw new exception("sortKeys must be a boolean or a function");
  }
  for (index = 0, length = objectKeyList.length; index < length; index += 1) {
    pairBuffer = "";
    if (!compact || _result !== "") {
      pairBuffer += generateNextLine(state, level);
    }
    objectKey = objectKeyList[index];
    objectValue = object[objectKey];
    if (state.replacer) {
      objectValue = state.replacer.call(object, objectKey, objectValue);
    }
    if (!writeNode(state, level + 1, objectKey, true, true, true)) {
      continue;
    }
    explicitPair = state.tag !== null && state.tag !== "?" || state.dump && state.dump.length > 1024;
    if (explicitPair) {
      if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
        pairBuffer += "?";
      } else {
        pairBuffer += "? ";
      }
    }
    pairBuffer += state.dump;
    if (explicitPair) {
      pairBuffer += generateNextLine(state, level);
    }
    if (!writeNode(state, level + 1, objectValue, true, explicitPair)) {
      continue;
    }
    if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
      pairBuffer += ":";
    } else {
      pairBuffer += ": ";
    }
    pairBuffer += state.dump;
    _result += pairBuffer;
  }
  state.tag = _tag;
  state.dump = _result || "{}";
}
function detectType(state, object, explicit) {
  var _result, typeList, index, length, type2, style;
  typeList = explicit ? state.explicitTypes : state.implicitTypes;
  for (index = 0, length = typeList.length; index < length; index += 1) {
    type2 = typeList[index];
    if ((type2.instanceOf || type2.predicate) && (!type2.instanceOf || typeof object === "object" && object instanceof type2.instanceOf) && (!type2.predicate || type2.predicate(object))) {
      if (explicit) {
        if (type2.multi && type2.representName) {
          state.tag = type2.representName(object);
        } else {
          state.tag = type2.tag;
        }
      } else {
        state.tag = "?";
      }
      if (type2.represent) {
        style = state.styleMap[type2.tag] || type2.defaultStyle;
        if (_toString.call(type2.represent) === "[object Function]") {
          _result = type2.represent(object, style);
        } else if (_hasOwnProperty.call(type2.represent, style)) {
          _result = type2.represent[style](object, style);
        } else {
          throw new exception("!<" + type2.tag + '> tag resolver accepts not "' + style + '" style');
        }
        state.dump = _result;
      }
      return true;
    }
  }
  return false;
}
function writeNode(state, level, object, block, compact, iskey, isblockseq) {
  state.tag = null;
  state.dump = object;
  if (!detectType(state, object, false)) {
    detectType(state, object, true);
  }
  var type2 = _toString.call(state.dump);
  var inblock = block;
  var tagStr;
  if (block) {
    block = state.flowLevel < 0 || state.flowLevel > level;
  }
  var objectOrArray = type2 === "[object Object]" || type2 === "[object Array]", duplicateIndex, duplicate;
  if (objectOrArray) {
    duplicateIndex = state.duplicates.indexOf(object);
    duplicate = duplicateIndex !== -1;
  }
  if (state.tag !== null && state.tag !== "?" || duplicate || state.indent !== 2 && level > 0) {
    compact = false;
  }
  if (duplicate && state.usedDuplicates[duplicateIndex]) {
    state.dump = "*ref_" + duplicateIndex;
  } else {
    if (objectOrArray && duplicate && !state.usedDuplicates[duplicateIndex]) {
      state.usedDuplicates[duplicateIndex] = true;
    }
    if (type2 === "[object Object]") {
      if (block && Object.keys(state.dump).length !== 0) {
        writeBlockMapping(state, level, state.dump, compact);
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + state.dump;
        }
      } else {
        writeFlowMapping(state, level, state.dump);
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + " " + state.dump;
        }
      }
    } else if (type2 === "[object Array]") {
      if (block && state.dump.length !== 0) {
        if (state.noArrayIndent && !isblockseq && level > 0) {
          writeBlockSequence(state, level - 1, state.dump, compact);
        } else {
          writeBlockSequence(state, level, state.dump, compact);
        }
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + state.dump;
        }
      } else {
        writeFlowSequence(state, level, state.dump);
        if (duplicate) {
          state.dump = "&ref_" + duplicateIndex + " " + state.dump;
        }
      }
    } else if (type2 === "[object String]") {
      if (state.tag !== "?") {
        writeScalar(state, state.dump, level, iskey, inblock);
      }
    } else if (type2 === "[object Undefined]") {
      return false;
    } else {
      if (state.skipInvalid) return false;
      throw new exception("unacceptable kind of an object to dump " + type2);
    }
    if (state.tag !== null && state.tag !== "?") {
      tagStr = encodeURI(
        state.tag[0] === "!" ? state.tag.slice(1) : state.tag
      ).replace(/!/g, "%21");
      if (state.tag[0] === "!") {
        tagStr = "!" + tagStr;
      } else if (tagStr.slice(0, 18) === "tag:yaml.org,2002:") {
        tagStr = "!!" + tagStr.slice(18);
      } else {
        tagStr = "!<" + tagStr + ">";
      }
      state.dump = tagStr + " " + state.dump;
    }
  }
  return true;
}
function getDuplicateReferences(object, state) {
  var objects = [], duplicatesIndexes = [], index, length;
  inspectNode(object, objects, duplicatesIndexes);
  for (index = 0, length = duplicatesIndexes.length; index < length; index += 1) {
    state.duplicates.push(objects[duplicatesIndexes[index]]);
  }
  state.usedDuplicates = new Array(length);
}
function inspectNode(object, objects, duplicatesIndexes) {
  var objectKeyList, index, length;
  if (object !== null && typeof object === "object") {
    index = objects.indexOf(object);
    if (index !== -1) {
      if (duplicatesIndexes.indexOf(index) === -1) {
        duplicatesIndexes.push(index);
      }
    } else {
      objects.push(object);
      if (Array.isArray(object)) {
        for (index = 0, length = object.length; index < length; index += 1) {
          inspectNode(object[index], objects, duplicatesIndexes);
        }
      } else {
        objectKeyList = Object.keys(object);
        for (index = 0, length = objectKeyList.length; index < length; index += 1) {
          inspectNode(object[objectKeyList[index]], objects, duplicatesIndexes);
        }
      }
    }
  }
}
function dump$1(input, options) {
  options = options || {};
  var state = new State(options);
  if (!state.noRefs) getDuplicateReferences(input, state);
  var value = input;
  if (state.replacer) {
    value = state.replacer.call({ "": value }, "", value);
  }
  if (writeNode(state, 0, value, true, true)) return state.dump + "\n";
  return "";
}
var dump_1 = dump$1;
var dumper = {
  dump: dump_1
};
function renamed(from, to) {
  return function() {
    throw new Error("Function yaml." + from + " is removed in js-yaml 4. Use yaml." + to + " instead, which is now safe by default.");
  };
}
var Type = type;
var Schema = schema;
var FAILSAFE_SCHEMA = failsafe;
var JSON_SCHEMA = json;
var CORE_SCHEMA = core;
var DEFAULT_SCHEMA = _default;
var load = loader.load;
var loadAll = loader.loadAll;
var dump = dumper.dump;
var YAMLException = exception;
var types = {
  binary,
  float,
  map,
  null: _null,
  pairs,
  set,
  timestamp,
  bool,
  int,
  merge,
  omap,
  seq,
  str
};
var safeLoad = renamed("safeLoad", "load");
var safeLoadAll = renamed("safeLoadAll", "loadAll");
var safeDump = renamed("safeDump", "dump");
var jsYaml = {
  Type,
  Schema,
  FAILSAFE_SCHEMA,
  JSON_SCHEMA,
  CORE_SCHEMA,
  DEFAULT_SCHEMA,
  load,
  loadAll,
  dump,
  YAMLException,
  types,
  safeLoad,
  safeLoadAll,
  safeDump
};
const jsYaml$1 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  CORE_SCHEMA,
  DEFAULT_SCHEMA,
  FAILSAFE_SCHEMA,
  JSON_SCHEMA,
  Schema,
  Type,
  YAMLException,
  default: jsYaml,
  dump,
  load,
  loadAll,
  safeDump,
  safeLoad,
  safeLoadAll,
  types
}, Symbol.toStringTag, { value: "Module" }));
const require$$5 = /* @__PURE__ */ getAugmentedNamespace(jsYaml$1);
var autoUpdater;
var hasRequiredAutoUpdater;
function requireAutoUpdater() {
  if (hasRequiredAutoUpdater) return autoUpdater;
  hasRequiredAutoUpdater = 1;
  const { ipcMain, shell } = require$$0;
  const { app } = require$$0;
  let _mainWindow = null;
  let _updateChannel = "stable";
  let _updateState = {
    status: "idle",
    // idle | checking | available | error | latest
    version: null,
    releaseNotes: null,
    releaseUrl: null,
    // GitHub release page URL
    downloadUrl: null,
    // direct download URL (asset)
    error: null
  };
  function getState() {
    return { ..._updateState };
  }
  function sendToRenderer(channel, data) {
    if (_mainWindow && !_mainWindow.isDestroyed()) {
      _mainWindow.webContents.send(channel, data);
    }
  }
  function setState(patch) {
    Object.assign(_updateState, patch);
    sendToRenderer("auto-update-state", getState());
  }
  function resetState() {
    _updateState = {
      status: "idle",
      version: null,
      releaseNotes: null,
      releaseUrl: null,
      downloadUrl: null,
      error: null
    };
  }
  function isNewerVersion(latest, current) {
    const a = latest.split(".").map(Number);
    const b = current.split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) > (b[i] || 0)) return true;
      if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
  }
  const REPO_BASE_URL = "https://github.com/MerkyorLynn/Lynn";
  const UPDATE_MANIFEST_URLS = [
    "https://raw.githubusercontent.com/MerkyorLynn/Lynn/main/.github/update-manifest.json",
    "https://cdn.jsdelivr.net/gh/MerkyorLynn/Lynn@main/.github/update-manifest.json"
  ];
  function normalizeVersion(version) {
    return String(version || "").trim().replace(/^v/, "");
  }
  function buildReleaseUrl(version) {
    return `${REPO_BASE_URL}/releases/tag/v${version}`;
  }
  function buildReleaseDownloadBase(version) {
    return `${REPO_BASE_URL}/releases/download/v${version}`;
  }
  function getConventionalAssetName(version) {
    if (process.platform === "darwin") {
      if (process.arch === "arm64") return `Lynn-${version}-macOS-Apple-Silicon.dmg`;
      if (process.arch === "x64") return `Lynn-${version}-macOS-Intel.dmg`;
    }
    if (process.platform === "win32") {
      return `Lynn-${version}-Windows-Setup.exe`;
    }
    return null;
  }
  function getAssetOverride(release) {
    const assets = release?.assets;
    if (!assets || typeof assets !== "object") return null;
    const key = `${process.platform}-${process.arch}`;
    const candidates = [key, process.platform, process.arch, "default"];
    for (const name of candidates) {
      const value = assets[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }
  function pickManifestRelease(manifest) {
    if (!manifest || typeof manifest !== "object") return null;
    const stable = manifest.stable && typeof manifest.stable === "object" ? manifest.stable : manifest;
    if (_updateChannel === "beta") {
      return manifest.beta && typeof manifest.beta === "object" ? manifest.beta : stable;
    }
    return stable;
  }
  async function fetchUpdateManifest() {
    const cacheBust = `ts=${Date.now()}`;
    let lastError = null;
    for (const baseUrl of UPDATE_MANIFEST_URLS) {
      const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${cacheBust}`;
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "Lynn" },
          signal: AbortSignal.timeout(15e3)
        });
        if (!res.ok) {
          lastError = `manifest ${res.status}`;
          continue;
        }
        const data = await res.json();
        if (data && typeof data === "object") return data;
        lastError = "manifest invalid";
      } catch (err) {
        lastError = err?.message || String(err);
      }
    }
    throw new Error(lastError || "update manifest unavailable");
  }
  async function checkUpdate() {
    setState({ status: "checking", error: null, version: null });
    try {
      const manifest = await fetchUpdateManifest();
      const release = pickManifestRelease(manifest);
      if (!release) {
        setState({ status: "latest" });
        return null;
      }
      const latest = normalizeVersion(release.version || release.tag || release.tag_name);
      const current = app.getVersion();
      if (!latest || !isNewerVersion(latest, current)) {
        setState({ status: "latest" });
        return null;
      }
      const releaseUrl = release.releaseUrl || release.html_url || buildReleaseUrl(latest);
      const assetOverride = getAssetOverride(release);
      const conventionalAssetName = getConventionalAssetName(latest);
      const downloadUrl = assetOverride || (conventionalAssetName ? `${buildReleaseDownloadBase(latest)}/${encodeURIComponent(conventionalAssetName)}` : null) || releaseUrl;
      setState({
        status: "available",
        version: latest,
        releaseNotes: release.notes || release.body || null,
        releaseUrl,
        downloadUrl
      });
      return latest;
    } catch (err) {
      setState({ status: "error", error: err?.message || String(err) });
      return null;
    }
  }
  function initAutoUpdater(mainWindow) {
    _mainWindow = mainWindow;
    ipcMain.handle("auto-update-check", async () => {
      resetState();
      return checkUpdate();
    });
    ipcMain.handle("auto-update-download", async () => {
      if (_updateState.downloadUrl) {
        shell.openExternal(_updateState.downloadUrl);
      }
      return true;
    });
    ipcMain.handle("auto-update-install", () => {
      if (_updateState.releaseUrl) {
        shell.openExternal(_updateState.releaseUrl);
      }
    });
    ipcMain.handle("auto-update-state", () => {
      return getState();
    });
    ipcMain.handle("auto-update-set-channel", (_event, channel) => {
      _updateChannel = channel === "beta" ? "beta" : "stable";
    });
  }
  async function checkForUpdatesAuto() {
    return checkUpdate();
  }
  function setUpdateChannel(channel) {
    _updateChannel = channel === "beta" ? "beta" : "stable";
  }
  function setMainWindow(win) {
    _mainWindow = win;
  }
  autoUpdater = { initAutoUpdater, checkForUpdatesAuto, setMainWindow, setUpdateChannel, getState };
  return autoUpdater;
}
var ipcWrapper;
var hasRequiredIpcWrapper;
function requireIpcWrapper() {
  if (hasRequiredIpcWrapper) return ipcWrapper;
  hasRequiredIpcWrapper = 1;
  const { ipcMain } = require$$0;
  function wrapIpcHandler(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args);
      } catch (err) {
        const traceId = Math.random().toString(16).slice(2, 10);
        console.error(`[IPC][${channel}][${traceId}] ${err?.message || err}`);
        return void 0;
      }
    });
  }
  function wrapIpcOn(channel, handler) {
    ipcMain.on(channel, (event, ...args) => {
      try {
        const result = handler(event, ...args);
        if (result && typeof result.catch === "function") {
          result.catch((err) => {
            console.error(`[IPC][${channel}] async: ${err?.message || err}`);
          });
        }
      } catch (err) {
        console.error(`[IPC][${channel}] ${err?.message || err}`);
      }
    });
  }
  ipcWrapper = { wrapIpcHandler, wrapIpcOn };
  return ipcWrapper;
}
var hasRequiredMain;
function requireMain() {
  if (hasRequiredMain) return main$1;
  hasRequiredMain = 1;
  const { app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, dialog, session, shell, nativeTheme, Tray, Menu, nativeImage, systemPreferences, Notification } = require$$0;
  const os = require$$1;
  const path = require$$2;
  const { spawn, execFileSync } = require$$3;
  const fs = require$$4;
  const yaml = require$$5;
  const { initAutoUpdater, checkForUpdatesAuto, setMainWindow: setUpdaterMainWindow, setUpdateChannel } = requireAutoUpdater();
  const { wrapIpcHandler, wrapIpcOn } = requireIpcWrapper();
  if (process.platform !== "win32") {
    try {
      const loginShell = process.env.SHELL || "/bin/zsh";
      const resolved = execFileSync(loginShell, ["-l", "-c", "printenv PATH"], {
        timeout: 5e3,
        encoding: "utf8"
      }).trim();
      if (resolved) process.env.PATH = resolved;
    } catch {
    }
  }
  function safeReadJSON(filePath, fallback = null) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      console.error(`[safeReadJSON] ${filePath}: ${err.message}`);
      return fallback;
    }
  }
  const lynnHome = process.env.LYNN_HOME ? path.resolve(process.env.LYNN_HOME.replace(/^~/, os.homedir())) : process.env.HANA_HOME ? path.resolve(process.env.HANA_HOME.replace(/^~/, os.homedir())) : path.join(os.homedir(), ".lynn");
  const defaultHome = path.join(os.homedir(), ".lynn");
  if (lynnHome !== defaultHome) {
    const suffix = path.basename(lynnHome).replace(/^\./, "");
    const appName = suffix.charAt(0).toUpperCase() + suffix.slice(1);
    app.setPath("userData", path.join(app.getPath("appData"), appName));
  }
  let splashWindow = null;
  let mainWindow = null;
  let onboardingWindow = null;
  let _mainWindowReadyWaiters = [];
  let settingsWindow = null;
  let settingsWindowInitialNavigationTarget = null;
  let settingsWindowContentStamp = null;
  let preferredPrimaryWindowKind = "main";
  let browserViewerWindow = null;
  let _browserWebView = null;
  const _browserViews = /* @__PURE__ */ new Map();
  let _currentBrowserSession = null;
  const _isDev = process.argv.includes("--dev");
  const _distRenderer = path.join(__dirname, "dist-renderer");
  function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function loadWindowErrorPage(win, pageName, err) {
    const detail = escapeHtml(err?.message || err || "unknown error");
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageName)}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
      background: #f8f5ed;
      color: #4f5b66;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .card {
      width: min(560px, 100%);
      background: rgba(255,255,255,0.88);
      border-radius: 18px;
      box-shadow: 0 18px 40px rgba(74, 92, 106, 0.12);
      padding: 24px 28px;
    }
    h1 { margin: 0 0 10px; font-size: 20px; color: #3f4a55; }
    p { margin: 0; line-height: 1.7; }
    code {
      display: block;
      margin-top: 14px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(79, 91, 102, 0.08);
      color: #556372;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(pageName)} 加载失败</h1>
    <p>这个窗口没有正确加载出来。重新打开一次试试；如果仍然出现，请把下面这段错误信息发给开发者。</p>
    <code>${detail}</code>
  </div>
</body>
</html>`;
    return win.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  }
  function loadWindowURL(win, pageName, opts) {
    if (_isDev && process.env.VITE_DEV_URL) {
      let url = `${process.env.VITE_DEV_URL}/${pageName}.html`;
      if (opts?.query && Object.keys(opts.query).length > 0) {
        const qs = new URLSearchParams(opts.query).toString();
        url += `?${qs}`;
      }
      return win.loadURL(url);
    } else {
      const built = path.join(_distRenderer, `${pageName}.html`);
      if (_isDev) {
        return win.loadFile(path.join(__dirname, "src", `${pageName}.html`), opts);
      }
      if (!fs.existsSync(built)) {
        const err = new Error(`renderer entry missing: ${built}`);
        console.error(`[desktop] ${pageName} 页面入口缺失: ${built}`);
        return loadWindowErrorPage(win, pageName, err);
      }
      return win.loadFile(built, opts).catch((err) => {
        console.error(`[desktop] ${pageName} 页面加载失败: ${err.message}`);
        return loadWindowErrorPage(win, pageName, err);
      });
    }
  }
  function getWindowEntryStamp(pageName) {
    try {
      const entryPath = _isDev ? path.join(__dirname, "src", `${pageName}.html`) : path.join(_distRenderer, `${pageName}.html`);
      const stat = fs.statSync(entryPath);
      return `${entryPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch {
      return `${pageName}:missing`;
    }
  }
  function isAllowedBrowserUrl(url) {
    try {
      const p = new URL(url);
      return p.protocol === "http:" || p.protocol === "https:";
    } catch {
      return false;
    }
  }
  let _browserViewerTheme = "warm-paper";
  const TITLEBAR_HEIGHT = 44;
  let serverProcess = null;
  let serverPort = null;
  let serverToken = null;
  let isQuitting = false;
  let tray = null;
  let reusedServerPid = null;
  let forceQuitApp = false;
  let _localAuthHeaderHookInstalled = false;
  let _mainI18nData = null;
  function _resolveLocaleKey(locale) {
    if (!locale) return "zh";
    if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
    if (locale.startsWith("zh")) return "zh";
    if (locale.startsWith("ja")) return "ja";
    if (locale.startsWith("ko")) return "ko";
    return "en";
  }
  function _getMainI18n() {
    if (_mainI18nData) return _mainI18nData;
    try {
      let locale = null;
      try {
        const prefs = JSON.parse(fs.readFileSync(path.join(lynnHome, "preferences.json"), "utf-8"));
        locale = prefs.locale || null;
      } catch {
      }
      const key = _resolveLocaleKey(locale);
      const file = path.join(__dirname, "src", "locales", `${key}.json`);
      const all = JSON.parse(fs.readFileSync(file, "utf-8"));
      _mainI18nData = all.main || {};
    } catch {
      _mainI18nData = {};
    }
    return _mainI18nData;
  }
  function mt(dotPath, vars, fallback) {
    const data = _getMainI18n();
    const val = dotPath.split(".").reduce((obj, k) => obj?.[k], data);
    let text = typeof val === "string" ? val : fallback || dotPath;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, "g"), v);
      }
    }
    return text;
  }
  function resetMainI18n() {
    _mainI18nData = null;
  }
  function killPid(pid, force = false) {
    if (process.platform === "win32") {
      try {
        require("child_process").execFileSync(
          "taskkill",
          force ? ["/F", "/T", "/PID", String(pid)] : ["/PID", String(pid)],
          { stdio: "ignore", windowsHide: true }
        );
      } catch {
      }
    } else {
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
      }
    }
  }
  function resolveMainWindowReady(ok = true) {
    const waiters = _mainWindowReadyWaiters;
    _mainWindowReadyWaiters = [];
    for (const finish of waiters) {
      try {
        finish(ok);
      } catch {
      }
    }
  }
  function waitForMainWindowReady(timeoutMs = 15e3) {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      _mainWindowReadyWaiters.push(finish);
      setTimeout(() => finish(false), timeoutMs);
    });
  }
  function shouldAttachLocalAuthHeader(urlString) {
    try {
      const parsed = new URL(urlString);
      const isLocalHost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
      return parsed.protocol === "http:" && isLocalHost && (!serverPort || parsed.port === String(serverPort));
    } catch {
      return false;
    }
  }
  function ensureLocalAuthHeaderHook() {
    if (_localAuthHeaderHookInstalled || !session.defaultSession) return;
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (!serverToken || !shouldAttachLocalAuthHeader(details.url)) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      const requestHeaders = { ...details.requestHeaders };
      if (!requestHeaders.Authorization) {
        requestHeaders.Authorization = `Bearer ${serverToken}`;
      }
      callback({ requestHeaders });
    });
    _localAuthHeaderHookInstalled = true;
  }
  const _fileAccessGrants = /* @__PURE__ */ new Map();
  const _trackedGrantWebContents = /* @__PURE__ */ new Set();
  function normalizePolicyPath(p) {
    return process.platform === "win32" ? p.toLowerCase() : p;
  }
  function resolveCanonicalPath(rawPath) {
    if (typeof rawPath !== "string") return null;
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes("\0")) return null;
    const absolute = path.resolve(trimmed);
    try {
      return fs.realpathSync(absolute);
    } catch (err) {
      if (err?.code !== "ENOENT") return null;
      const pending = [];
      let current = absolute;
      while (true) {
        const parent = path.dirname(current);
        if (parent === current) return null;
        pending.unshift(path.basename(current));
        try {
          const realParent = fs.realpathSync(parent);
          return path.join(realParent, ...pending);
        } catch (parentErr) {
          if (parentErr?.code !== "ENOENT") return null;
          current = parent;
        }
      }
    }
  }
  function isPathInsideRoot(targetPath, rootPath) {
    const target = normalizePolicyPath(path.resolve(targetPath));
    const root = normalizePolicyPath(path.resolve(rootPath));
    return target === root || target.startsWith(root + path.sep);
  }
  function uniqueCanonicalPaths(paths) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const p of paths) {
      const canonical = resolveCanonicalPath(p);
      if (!canonical) continue;
      const key = normalizePolicyPath(canonical);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(canonical);
    }
    return out;
  }
  function readUserPreferences() {
    return safeReadJSON(path.join(lynnHome, "user", "preferences.json"), {}) || {};
  }
  function writeUserPreferences(nextPrefs) {
    const prefsPath = path.join(lynnHome, "user", "preferences.json");
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify(nextPrefs, null, 2) + "\n", "utf-8");
  }
  const CANONICAL_BRAIN_API_ROOT = "https://api.merkyorlynn.com/api";
  const CANONICAL_BRAIN_PROVIDER_BASE_URL = `${CANONICAL_BRAIN_API_ROOT}/v1`;
  const DEPRECATED_BRAIN_API_ROOTS = /* @__PURE__ */ new Set([
    "http://82.156.182.240/api"
  ]);
  const DEPRECATED_BRAIN_PROVIDER_BASE_URLS = /* @__PURE__ */ new Set([
    "http://82.156.182.240/api/v1"
  ]);
  function normalizeBrainUrl(value) {
    const text = String(value || "").trim();
    return text ? text.replace(/\/+$/, "") : "";
  }
  function isDeprecatedBrainApiRoot(value) {
    const normalized = normalizeBrainUrl(value);
    return normalized ? DEPRECATED_BRAIN_API_ROOTS.has(normalized) : false;
  }
  function isDeprecatedBrainProviderBaseUrl(value) {
    const normalized = normalizeBrainUrl(value);
    return normalized ? DEPRECATED_BRAIN_PROVIDER_BASE_URLS.has(normalized) : false;
  }
  function migrateBrainProviderStorage() {
    const providersPath = path.join(lynnHome, "added-models.yaml");
    try {
      const raw = fs.readFileSync(providersPath, "utf-8");
      const data = yaml.load(raw) || {};
      const brainProvider = data?.providers?.brain;
      if (!brainProvider || typeof brainProvider !== "object") return false;
      if (!isDeprecatedBrainProviderBaseUrl(brainProvider.base_url)) return false;
      brainProvider.base_url = CANONICAL_BRAIN_PROVIDER_BASE_URL;
      fs.writeFileSync(providersPath, yaml.dump(data, { lineWidth: 120 }), "utf-8");
      return true;
    } catch {
      return false;
    }
  }
  function deriveBrainApiRootFromProviders() {
    try {
      const providersPath = path.join(lynnHome, "added-models.yaml");
      const raw = fs.readFileSync(providersPath, "utf-8");
      const data = yaml.load(raw) || {};
      const baseUrl = String(data?.providers?.brain?.base_url || "").trim().replace(/\/+$/, "");
      if (!baseUrl) return "";
      return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
    } catch {
      return "";
    }
  }
  function readBrainRuntimeConfig() {
    const migratedProviderStorage = migrateBrainProviderStorage();
    const prefs = readUserPreferences();
    let changedPrefs = false;
    const normalize = normalizeBrainUrl;
    let persistedApiRoot = normalize(prefs.brain_api_root || prefs.default_model_api_root);
    if (isDeprecatedBrainApiRoot(persistedApiRoot)) {
      persistedApiRoot = CANONICAL_BRAIN_API_ROOT;
      prefs.brain_api_root = CANONICAL_BRAIN_API_ROOT;
      if (isDeprecatedBrainApiRoot(prefs.default_model_api_root)) {
        prefs.default_model_api_root = CANONICAL_BRAIN_API_ROOT;
      }
      changedPrefs = true;
    }
    const derivedApiRoot = persistedApiRoot || deriveBrainApiRootFromProviders();
    if (!persistedApiRoot && derivedApiRoot) {
      prefs.brain_api_root = derivedApiRoot;
      changedPrefs = true;
    }
    if (migratedProviderStorage && !prefs.brain_api_root) {
      prefs.brain_api_root = CANONICAL_BRAIN_API_ROOT;
      changedPrefs = true;
    }
    if (changedPrefs) {
      writeUserPreferences(prefs);
    }
    return {
      apiRoot: derivedApiRoot,
      host: normalize(prefs.brain_api_host || prefs.default_model_api_host),
      legacyApiRoot: normalize(prefs.brain_legacy_api_root),
      legacyHost: normalize(prefs.brain_legacy_host)
    };
  }
  function normalizeTrustedRoot(rawPath) {
    if (typeof rawPath !== "string") return null;
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes("\0")) return null;
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  function uniqueTrustedRoots(paths) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const entry of paths || []) {
      const normalized = normalizeTrustedRoot(entry);
      if (!normalized) continue;
      const key = normalizePolicyPath(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  }
  function getDefaultDesktopRoot() {
    return path.join(os.homedir(), "Desktop");
  }
  function isLegacyDesktopWorkspaceSeed(prefs = {}, configuredRoots = null) {
    if (prefs?.setupComplete === true) return false;
    const desktopRoot = getDefaultDesktopRoot();
    const topLevelHome = normalizeTrustedRoot(prefs?.home_folder);
    const deskHome = normalizeTrustedRoot(prefs?.desk?.home_folder);
    const topLevelRoots = configuredRoots ?? uniqueTrustedRoots(
      Array.isArray(prefs?.trusted_roots) ? prefs.trusted_roots : []
    );
    const deskRoots = uniqueTrustedRoots(
      Array.isArray(prefs?.desk?.trusted_roots) ? prefs.desk.trusted_roots : []
    );
    if (deskHome || deskRoots.length > 0) return false;
    const usesDesktopHome = topLevelHome === desktopRoot;
    const usesOnlyDesktopRoots = topLevelRoots.length > 0 && topLevelRoots.every((root) => root === desktopRoot);
    const hasOnlyLegacyTopLevelRoots = topLevelRoots.length === 0 || usesOnlyDesktopRoots;
    return hasOnlyLegacyTopLevelRoots && (usesDesktopHome || usesOnlyDesktopRoots);
  }
  function getPreferredHomeFolder(prefs = {}) {
    const configured = normalizeTrustedRoot(prefs?.home_folder) || normalizeTrustedRoot(prefs?.desk?.home_folder);
    if (!configured) return null;
    return isLegacyDesktopWorkspaceSeed(prefs) ? null : configured;
  }
  function getConfiguredTrustedRoots(prefs = {}) {
    const configuredRoots = uniqueTrustedRoots([
      ...Array.isArray(prefs?.trusted_roots) ? prefs.trusted_roots : [],
      ...Array.isArray(prefs?.desk?.trusted_roots) ? prefs.desk.trusted_roots : []
    ]);
    return isLegacyDesktopWorkspaceSeed(prefs, configuredRoots) ? [] : configuredRoots;
  }
  function getEffectiveTrustedRoots(prefs = {}) {
    return uniqueTrustedRoots([
      getPreferredHomeFolder(prefs),
      ...getConfiguredTrustedRoots(prefs)
    ]);
  }
  function getConfiguredWorkspaceRoots(config = {}, prefs = {}) {
    const history = Array.isArray(config?.cwd_history) ? config.cwd_history : [];
    return uniqueTrustedRoots([
      ...getEffectiveTrustedRoots(prefs),
      config?.last_cwd,
      ...history
    ]);
  }
  function readCurrentAgentConfig() {
    const agentId = getCurrentAgentId();
    if (!agentId) return {};
    try {
      const configPath = path.join(lynnHome, "agents", agentId, "config.yaml");
      return yaml.load(fs.readFileSync(configPath, "utf-8")) || {};
    } catch {
      return {};
    }
  }
  function listAgentRoots(subdir) {
    const agentsDir = path.join(lynnHome, "agents");
    try {
      return fs.readdirSync(agentsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml"))).map((entry) => path.join(agentsDir, entry.name, subdir));
    } catch {
      return [];
    }
  }
  function getWorkspaceRoots() {
    const prefs = readUserPreferences();
    const config = readCurrentAgentConfig();
    return uniqueCanonicalPaths(getConfiguredWorkspaceRoots(config, prefs));
  }
  function getExternalSkillRoots() {
    const prefs = readUserPreferences();
    return uniqueCanonicalPaths(Array.isArray(prefs.external_skill_paths) ? prefs.external_skill_paths : []);
  }
  function getTrustedPathPolicy() {
    const workspaceRoots = getWorkspaceRoots();
    const uploadsRoots = workspaceRoots.map((root) => path.join(root, ".lynn-uploads"));
    return {
      read: uniqueCanonicalPaths([
        path.join(lynnHome, "skills"),
        ...listAgentRoots("desk"),
        ...listAgentRoots("learned-skills"),
        ...workspaceRoots,
        ...uploadsRoots,
        path.join(os.tmpdir(), ".lynn-uploads"),
        ...getExternalSkillRoots()
      ]),
      write: uniqueCanonicalPaths([
        ...workspaceRoots,
        ...uploadsRoots,
        path.join(os.tmpdir(), ".lynn-uploads")
      ])
    };
  }
  function resolveGrantTarget(target) {
    if (!target) return null;
    if (typeof target.id === "number" && typeof target.send === "function") return target;
    if (target.webContents && typeof target.webContents.id === "number") return target.webContents;
    return null;
  }
  function getGrantBucket(target) {
    const webContents = resolveGrantTarget(target);
    if (!webContents) return null;
    let bucket = _fileAccessGrants.get(webContents.id);
    if (!bucket) {
      bucket = { read: /* @__PURE__ */ new Set(), write: /* @__PURE__ */ new Set() };
      _fileAccessGrants.set(webContents.id, bucket);
    }
    if (!_trackedGrantWebContents.has(webContents.id)) {
      _trackedGrantWebContents.add(webContents.id);
      webContents.once("destroyed", () => {
        _fileAccessGrants.delete(webContents.id);
        _trackedGrantWebContents.delete(webContents.id);
      });
    }
    return bucket;
  }
  function grantWebContentsAccess(target, rawPath, level = "read") {
    const canonical = resolveCanonicalPath(rawPath);
    const bucket = getGrantBucket(target);
    if (!canonical || !bucket) return null;
    bucket.read.add(canonical);
    if (level === "write" || level === "readwrite") {
      bucket.write.add(canonical);
    }
    return canonical;
  }
  function hasGrantedAccess(target, canonicalPath, mode) {
    const webContents = resolveGrantTarget(target);
    if (!webContents) return false;
    const bucket = _fileAccessGrants.get(webContents.id);
    if (!bucket) return false;
    const candidates = mode === "write" ? [...bucket.write] : [...bucket.read, ...bucket.write];
    return candidates.some((root) => isPathInsideRoot(canonicalPath, root));
  }
  function hasTrustedAccess(canonicalPath, mode) {
    const policy = getTrustedPathPolicy();
    const roots = mode === "write" ? policy.write : policy.read;
    return roots.some((root) => isPathInsideRoot(canonicalPath, root));
  }
  function canAccessPath(target, rawPath, mode = "read") {
    const canonical = resolveCanonicalPath(rawPath);
    if (!canonical) return { allowed: false, canonical: null };
    return {
      allowed: hasTrustedAccess(canonical, mode) || hasGrantedAccess(target, canonical, mode),
      canonical
    };
  }
  function canReadPath(target, rawPath) {
    return canAccessPath(target, rawPath, "read");
  }
  function canWritePath(target, rawPath) {
    return canAccessPath(target, rawPath, "write");
  }
  function titleBarOpts(trafficLight = { x: 16, y: 16 }) {
    if (process.platform === "darwin") {
      return { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLight };
    }
    return { frame: false };
  }
  function getCurrentAgentId() {
    const prefsPath = path.join(lynnHome, "user", "preferences.json");
    const agentsDir = path.join(lynnHome, "agents");
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
      if (prefs.primaryAgent) {
        const agentDir = path.join(agentsDir, prefs.primaryAgent);
        if (fs.existsSync(path.join(agentDir, "config.yaml"))) {
          return prefs.primaryAgent;
        }
      }
    } catch {
    }
    try {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml"))) {
          return entry.name;
        }
      }
    } catch {
    }
    return null;
  }
  function isSetupComplete() {
    const prefsPath = path.join(lynnHome, "user", "preferences.json");
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
      if (prefs.setupComplete === true) return true;
    } catch {
    }
    try {
      const agentsDir = path.join(lynnHome, "agents");
      const agents = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of agents) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const sessDir = path.join(agentsDir, entry.name, "sessions");
        if (!fs.existsSync(sessDir)) continue;
        const sessions = fs.readdirSync(sessDir).filter((f) => f.endsWith(".jsonl"));
        if (sessions.length > 0) {
          try {
            let prefs = {};
            try {
              prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
            } catch {
            }
            prefs.setupComplete = true;
            fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
            console.log("[desktop] 检测到已有 session，自动标记 setupComplete");
          } catch {
          }
          return true;
        }
      }
    } catch {
    }
    return false;
  }
  function hasExistingConfig() {
    try {
      const agentId = getCurrentAgentId();
      if (!agentId) return false;
      const configPath = path.join(lynnHome, "agents", agentId, "config.yaml");
      const configText = fs.readFileSync(configPath, "utf-8");
      if (/api_key:\s*["']?[^"'\s]+/.test(configText)) {
        return true;
      }
      const parsedConfig = yaml.load(configText) || {};
      const currentProvider = String(parsedConfig?.api?.provider || "").trim();
      const providersPath = path.join(lynnHome, "added-models.yaml");
      const providersRaw = fs.readFileSync(providersPath, "utf-8");
      const providersData = yaml.load(providersRaw) || {};
      const providers = providersData?.providers || {};
      const hasProviderKey = (entry) => typeof entry?.api_key === "string" && String(entry.api_key).trim().length > 0;
      if (currentProvider && hasProviderKey(providers[currentProvider])) {
        return true;
      }
      return Object.values(providers).some(hasProviderKey);
    } catch {
    }
    return false;
  }
  let _serverLogs = [];
  function pollServerInfo(infoPath, { timeout = 6e4, interval = 200, process: proc } = {}) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      let exited = false;
      if (proc) {
        proc.on("exit", (code, signal) => {
          exited = true;
          reject(new Error(
            signal ? mt("dialog.serverKilledBySignal", { signal }) : mt("dialog.serverExitedWithCode", { code })
          ));
        });
      }
      const check = () => {
        if (exited) return;
        if (Date.now() > deadline) {
          reject(new Error(mt("dialog.serverStartTimeout", null, "Server start timed out (60s)")));
          return;
        }
        try {
          const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
          try {
            process.kill(info.pid, 0);
          } catch {
            setTimeout(check, interval);
            return;
          }
          resolve(info);
        } catch {
          setTimeout(check, interval);
        }
      };
      check();
    });
  }
  async function startServer() {
    const serverInfoPath = path.join(lynnHome, "server-info.json");
    let existingInfo = null;
    try {
      existingInfo = JSON.parse(fs.readFileSync(serverInfoPath, "utf-8"));
    } catch {
    }
    if (existingInfo) {
      const pidAlive = (() => {
        try {
          process.kill(existingInfo.pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      if (pidAlive) {
        let reused = false;
        try {
          const res = await fetch(`http://127.0.0.1:${existingInfo.port}/api/health`, {
            headers: { Authorization: `Bearer ${existingInfo.token}` },
            signal: AbortSignal.timeout(2e3)
          });
          if (res.ok) {
            console.log(`[desktop] 复用已运行的 server，端口: ${existingInfo.port}`);
            serverPort = existingInfo.port;
            serverToken = existingInfo.token;
            reusedServerPid = existingInfo.pid;
            ensureLocalAuthHeaderHook();
            reused = true;
          }
        } catch {
        }
        if (reused) return;
        console.log(`[desktop] 旧 server (PID ${existingInfo.pid}) 无响应，正在终止...`);
        killPid(existingInfo.pid);
        const deadline = Date.now() + 2e3;
        while (Date.now() < deadline) {
          try {
            process.kill(existingInfo.pid, 0);
          } catch {
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        killPid(existingInfo.pid, true);
      }
      try {
        fs.unlinkSync(serverInfoPath);
      } catch {
      }
    }
    _serverLogs = [];
    const serverEnv = { ...process.env, LYNN_HOME: lynnHome };
    const brainRuntime = readBrainRuntimeConfig();
    if (brainRuntime.apiRoot) serverEnv.BRAIN_API_ROOT_URL = brainRuntime.apiRoot;
    if (brainRuntime.host) serverEnv.BRAIN_API_HOST = brainRuntime.host;
    if (brainRuntime.legacyApiRoot) serverEnv.BRAIN_LEGACY_API_ROOT_URL = brainRuntime.legacyApiRoot;
    if (brainRuntime.legacyHost) serverEnv.BRAIN_LEGACY_HOST = brainRuntime.legacyHost;
    if (process.platform === "win32") {
      const gitRoot = path.join(process.resourcesPath || "", "git");
      const gitPaths = [
        path.join(gitRoot, "mingw64", "bin"),
        path.join(gitRoot, "cmd")
      ].filter((p) => fs.existsSync(p));
      if (gitPaths.length) {
        const pathKey = Object.keys(serverEnv).find((k) => k.toLowerCase() === "path") || "PATH";
        const existingPath = serverEnv[pathKey] || "";
        if (pathKey !== "PATH") delete serverEnv[pathKey];
        serverEnv.PATH = gitPaths.join(";") + ";" + existingPath;
      }
    }
    let serverBin, serverArgs;
    const bundledServerDir = path.join(process.resourcesPath || "", "server");
    const bundledWrapper = path.join(bundledServerDir, "lynn-server");
    const bundledExe = path.join(bundledServerDir, "lynn-server.exe");
    const bundledNode = path.join(bundledServerDir, process.platform === "win32" ? "lynn-server.exe" : "node");
    const bundledEntry = path.join(bundledServerDir, "bundle", "index.js");
    const hasBundledWrapper = fs.existsSync(bundledWrapper) || fs.existsSync(bundledExe);
    const hasBundledNodeRuntime = fs.existsSync(bundledNode) && fs.existsSync(bundledEntry);
    if (hasBundledWrapper || hasBundledNodeRuntime) {
      if (process.platform === "win32") {
        serverBin = fs.existsSync(bundledExe) ? bundledExe : bundledNode;
        serverArgs = [bundledEntry];
      } else if (fs.existsSync(bundledWrapper)) {
        serverBin = bundledWrapper;
        serverArgs = [];
      } else {
        serverBin = bundledNode;
        serverArgs = [bundledEntry];
      }
      serverEnv.HANA_ROOT = bundledServerDir;
    } else {
      serverBin = process.execPath;
      serverArgs = [path.join(__dirname, "..", "server", "index.js")];
      serverEnv.ELECTRON_RUN_AS_NODE = "1";
    }
    try {
      fs.unlinkSync(serverInfoPath);
    } catch {
    }
    serverProcess = spawn(serverBin, serverArgs, {
      detached: true,
      windowsHide: true,
      env: serverEnv,
      stdio: ["pipe", "pipe", "pipe"]
    });
    serverProcess.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      try {
        process.stdout.write(text);
      } catch {
      }
      _serverLogs.push(text);
      if (_serverLogs.length > 500) _serverLogs.splice(0, _serverLogs.length - 500);
    });
    serverProcess.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      try {
        process.stderr.write(text);
      } catch {
      }
      _serverLogs.push("[stderr] " + text);
      if (_serverLogs.length > 500) _serverLogs.splice(0, _serverLogs.length - 500);
    });
    const info = await pollServerInfo(serverInfoPath, {
      timeout: 6e4,
      process: serverProcess
    });
    serverPort = info.port;
    serverToken = info.token;
    ensureLocalAuthHeaderHook();
    serverProcess.unref();
  }
  let _serverRestartAttempts = 0;
  function monitorServer() {
    if (!serverProcess) return;
    serverProcess.on("exit", async (code, signal) => {
      if (isQuitting) return;
      const reason = signal ? `信号 ${signal}` : `退出码 ${code}`;
      console.error(`[desktop] Server 意外退出 (${reason})`);
      if (_serverRestartAttempts < 1) {
        _serverRestartAttempts++;
        console.log("[desktop] 尝试自动重启 Server...");
        try {
          await startServer();
          console.log("[desktop] Server 重启成功");
          monitorServer();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("server-restarted", { port: serverPort, token: serverToken });
          }
          if (settingsWindow && !settingsWindow.isDestroyed()) {
            settingsWindow.webContents.send("server-restarted", { port: serverPort, token: serverToken });
          }
        } catch (err) {
          console.error("[desktop] Server 重启失败:", err.message);
          writeCrashLog(`Server 重启失败: ${err.message}`);
          dialog.showErrorBox("Lynn Server", mt("dialog.serverRestartFailed", { error: err.message }));
        }
      } else {
        writeCrashLog(`Server 多次崩溃 (${reason})，放弃重启`);
        dialog.showErrorBox("Lynn Server", mt("dialog.serverMultipleCrash", { reason }));
      }
    });
  }
  function markPreferredPrimaryWindow(kind) {
    if (typeof kind === "string" && kind) preferredPrimaryWindowKind = kind;
  }
  function getPreferredPrimaryWindow() {
    const windowByKind = {
      settings: settingsWindow,
      onboarding: onboardingWindow,
      browser: browserViewerWindow,
      editor: editorWindow,
      main: mainWindow
    };
    const preferred = windowByKind[preferredPrimaryWindowKind];
    if (preferred && !preferred.isDestroyed()) return preferred;
    return settingsWindow || onboardingWindow || browserViewerWindow || editorWindow || mainWindow || null;
  }
  function showPrimaryWindow() {
    if (process.platform === "darwin") app.dock.show();
    const win = getPreferredPrimaryWindow();
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  }
  function createTray() {
    if (process.platform === "darwin") {
      tray = null;
      return;
    }
    const isDev = lynnHome !== path.join(os.homedir(), ".lynn");
    let icon;
    if (process.platform === "win32") {
      const icoName = isDev ? "tray-dev.ico" : "tray.ico";
      const icoPath = path.join(__dirname, "src", "assets", icoName);
      if (fs.existsSync(icoPath)) {
        icon = nativeImage.createFromPath(icoPath);
      } else {
        const pngName = isDev ? "tray-dev-template.png" : "tray-template.png";
        icon = nativeImage.createFromPath(path.join(__dirname, "src", "assets", pngName));
      }
    } else {
      const iconName = isDev ? "tray-dev-template.png" : "tray-template.png";
      const iconPath = path.join(__dirname, "src", "assets", iconName);
      icon = nativeImage.createFromPath(iconPath);
      if (process.platform === "darwin") icon.setTemplateImage(true);
    }
    tray = new Tray(icon);
    tray.setToolTip(isDev ? "Lynn (dev)" : "Lynn");
    const buildMenu = () => Menu.buildFromTemplate([
      { label: mt("tray.show", null, "Show Lynn"), click: () => showPrimaryWindow() },
      { label: mt("tray.settings", null, "Settings"), click: () => createSettingsWindow() },
      { type: "separator" },
      { label: mt("tray.quit", null, "Quit"), click: () => {
        isQuitting = true;
        app.quit();
      } }
    ]);
    tray.setContextMenu(buildMenu());
    tray.on("right-click", () => tray.setContextMenu(buildMenu()));
    tray.on("double-click", () => showPrimaryWindow());
  }
  function writeCrashLog(errorMessage) {
    const logs = _serverLogs.join("");
    const timestamp2 = (/* @__PURE__ */ new Date()).toISOString();
    let diagnostics = "";
    if (!logs) {
      const isPackaged = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, "server"));
      const serverDir = isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "..", "server");
      const sqlitePath = path.join(
        serverDir,
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node"
      );
      const bundlePath = path.join(serverDir, "bundle", "index.js");
      const items = [
        ``,
        `--- Diagnostics ---`,
        `LYNN_HOME: ${lynnHome}`,
        `Server dir: ${serverDir}`,
        `Packaged: ${!!isPackaged}`,
        `bundle/index.js exists: ${fs.existsSync(bundlePath)}`,
        `better_sqlite3.node exists: ${fs.existsSync(sqlitePath)}`,
        `ELECTRON_RUN_AS_NODE: ${process.env.ELECTRON_RUN_AS_NODE || "unset"}`,
        `Node ABI: ${process.versions.modules || "unknown"}`
      ];
      if (process.platform === "win32" && isPackaged) {
        const exePath = path.join(serverDir, "lynn-server.exe");
        const cmdPath = path.join(serverDir, "lynn-server.cmd");
        const gitRoot = path.join(process.resourcesPath, "git");
        items.push(`lynn-server.exe exists: ${fs.existsSync(exePath)}`);
        items.push(`lynn-server.cmd exists (manual debug): ${fs.existsSync(cmdPath)}`);
        items.push(`MinGit dir exists: ${fs.existsSync(gitRoot)}`);
        items.push(``);
        items.push(`Manual debug: open cmd.exe, cd to "${serverDir}", run lynn-server.cmd`);
      }
      diagnostics = items.join("\n");
    }
    const content = [
      `=== Lynn Crash Log ===`,
      `Time: ${timestamp2}`,
      `Error: ${errorMessage}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Electron: ${process.versions.electron || "unknown"}`,
      `Node: ${process.versions.node || "unknown"}`,
      ``,
      `--- Server Output ---`,
      logs || "(no output captured)",
      diagnostics,
      ``
    ].join("\n");
    try {
      const crashLogPath = path.join(lynnHome, "crash.log");
      fs.mkdirSync(lynnHome, { recursive: true });
      fs.writeFileSync(crashLogPath, content, "utf-8");
    } catch (e) {
      console.error("[desktop] 写入 crash.log 失败:", e.message);
    }
    return content;
  }
  function createSplashWindow() {
    splashWindow = new BrowserWindow({
      width: 380,
      height: 280,
      resizable: false,
      frame: false,
      title: "Lynn",
      transparent: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    if (process.platform === "darwin" && splashWindow.setWindowButtonVisibility) {
      splashWindow.setWindowButtonVisibility(false);
    }
    loadWindowURL(splashWindow, "splash");
    splashWindow.once("ready-to-show", () => {
      splashWindow.show();
    });
    splashWindow.on("closed", () => {
      splashWindow = null;
    });
  }
  const windowStatePath = path.join(lynnHome, "user", "window-state.json");
  function loadWindowState() {
    try {
      return JSON.parse(fs.readFileSync(windowStatePath, "utf-8"));
    } catch {
      return null;
    }
  }
  function normalizeMainWindowState(state) {
    if (!state || process.platform !== "darwin" || state.isMaximized) return state;
    const next = { ...state };
    if (typeof next.y === "number" && next.y >= 0 && next.y <= TITLEBAR_HEIGHT) {
      next.y = 0;
    }
    return next;
  }
  let _saveWindowStateTimer = null;
  function saveWindowState() {
    if (_saveWindowStateTimer) clearTimeout(_saveWindowStateTimer);
    _saveWindowStateTimer = setTimeout(() => {
      _saveWindowStateTimer = null;
      if (!mainWindow) return;
      const isMaximized = mainWindow.isMaximized();
      const bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
      const state = { ...bounds, isMaximized };
      try {
        fs.writeFileSync(windowStatePath, JSON.stringify(state, null, 2) + "\n");
      } catch (e) {
        console.error("[desktop] 保存窗口状态失败:", e.message);
      }
    }, 500);
  }
  function createMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow;
    }
    const saved = normalizeMainWindowState(loadWindowState());
    const opts = {
      width: saved?.width || 960,
      height: saved?.height || 820,
      minWidth: 420,
      minHeight: 500,
      title: "Lynn",
      ...titleBarOpts({ x: 16, y: 16 }),
      backgroundColor: "#F4F0E4",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false
      }
    };
    if (saved?.x != null && saved?.y != null) {
      opts.x = saved.x;
      opts.y = saved.y;
    }
    mainWindow = new BrowserWindow(opts);
    initAutoUpdater(mainWindow);
    if (saved?.isMaximized) {
      mainWindow.maximize();
    }
    loadWindowURL(mainWindow, "index");
    const initTimeout = setTimeout(() => {
      console.warn("[desktop] ⚠ 主窗口初始化超时（30s），强制显示");
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show();
      }
    }, 3e4);
    mainWindow.webContents.once("did-finish-load", () => {
      console.log("[desktop] 主窗口 HTML 加载完成，等待前端 init...");
    });
    mainWindow.once("show", () => clearTimeout(initTimeout));
    if (process.argv.includes("--dev")) {
      mainWindow.webContents.openDevTools();
    }
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      console.error(`[desktop] renderer 崩溃: ${details.reason} (code: ${details.exitCode})`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        setTimeout(() => {
          try {
            mainWindow.reload();
          } catch {
          }
        }, 1e3);
      }
    });
    mainWindow.on("unresponsive", () => {
      console.warn("[desktop] 主窗口无响应");
    });
    mainWindow.on("responsive", () => {
      console.log("[desktop] 主窗口已恢复响应");
    });
    mainWindow.on("resize", saveWindowState);
    mainWindow.on("move", saveWindowState);
    mainWindow.on("focus", () => {
      markPreferredPrimaryWindow("main");
      if (process.platform === "darwin") {
        _pendingNotificationCount = 0;
        app.dock.setBadge("");
      }
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          event.preventDefault();
          shell.openExternal(url);
        }
      } catch {
      }
    });
    mainWindow.on("maximize", () => mainWindow.webContents.send("window-maximized"));
    mainWindow.on("unmaximize", () => mainWindow.webContents.send("window-unmaximized"));
    mainWindow.on("close", (e) => {
      if (!isQuitting) {
        e.preventDefault();
        mainWindow.hide();
        if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.hide();
        if (editorWindow && !editorWindow.isDestroyed()) editorWindow.hide();
      }
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.destroy();
        settingsWindow = null;
      }
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.destroy();
        browserViewerWindow = null;
      }
      if (editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.destroy();
        editorWindow = null;
      }
    });
    return mainWindow;
  }
  const THEME_BG = {
    "warm-paper": "#F8F5ED",
    "midnight": "#2D4356",
    "high-contrast": "#FAF9F6",
    "grass-aroma": "#F5F8F3",
    "contemplation": "#F3F5F7"
  };
  function normalizeSettingsNavigationTarget(target) {
    if (!target) return null;
    if (typeof target === "string") return { tab: target };
    if (typeof target !== "object") return null;
    const next = {};
    if (typeof target.tab === "string" && target.tab) next.tab = target.tab;
    if (target.providerId === null || typeof target.providerId === "string") next.providerId = target.providerId ?? null;
    if (target.resetProviderSelection === true) next.resetProviderSelection = true;
    if (target.agentId === null || typeof target.agentId === "string") next.agentId = target.agentId ?? null;
    if (target.resetAgentSelection === true) next.resetAgentSelection = true;
    if (target.reviewerKind === "hanako" || target.reviewerKind === "butter") next.reviewerKind = target.reviewerKind;
    return Object.keys(next).length > 0 ? next : null;
  }
  function createSettingsWindow(target, theme) {
    const navigationTarget = normalizeSettingsNavigationTarget(target);
    const desiredStamp = getWindowEntryStamp("settings");
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.webContents.isCrashed()) {
        console.warn("[desktop] settings renderer 已崩溃，重建窗口");
        settingsWindow.destroy();
        settingsWindow = null;
      } else if ((settingsWindow.webContents.getURL() || "").startsWith("data:text/html")) {
        console.warn("[desktop] settings window 处于错误页，重建窗口");
        settingsWindow.destroy();
        settingsWindow = null;
      } else if (settingsWindowContentStamp && settingsWindowContentStamp !== desiredStamp) {
        console.warn("[desktop] settings window 资源已更新，重建窗口");
        settingsWindow.destroy();
        settingsWindow = null;
      } else {
        if (navigationTarget) settingsWindow.webContents.send("settings-switch-tab", navigationTarget);
        settingsWindow.show();
        settingsWindow.focus();
        return;
      }
    }
    settingsWindowInitialNavigationTarget = navigationTarget;
    settingsWindowContentStamp = desiredStamp;
    markPreferredPrimaryWindow("settings");
    settingsWindow = new BrowserWindow({
      width: 720,
      height: 700,
      minWidth: 720,
      maxWidth: 720,
      minHeight: 500,
      title: "Settings",
      ...titleBarOpts({ x: 16, y: 14 }),
      backgroundColor: THEME_BG[theme || _browserViewerTheme] || THEME_BG["warm-paper"],
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    settingsWindow.once("ready-to-show", () => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        markPreferredPrimaryWindow("settings");
        settingsWindow.show();
        settingsWindow.focus();
      }
    });
    settingsWindow.on("focus", () => {
      markPreferredPrimaryWindow("settings");
    });
    settingsWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      console.error(`[desktop] settings did-fail-load: ${errorCode} ${errorDescription} ${validatedURL}`);
      if (settingsWindow && !settingsWindow.isDestroyed() && !String(validatedURL || "").startsWith("data:text/html")) {
        void loadWindowErrorPage(settingsWindow, "settings", new Error(`${errorCode} ${errorDescription}`));
      }
    });
    settingsWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      if (level >= 2) {
        console.warn(`[desktop] settings console(${level}) ${sourceId}:${line} ${message}`);
      }
    });
    void Promise.allSettled([
      settingsWindow.webContents.session.clearCache(),
      settingsWindow.webContents.session.clearStorageData({ storages: ["cachestorage", "serviceworkers"] })
    ]).finally(() => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        void loadWindowURL(settingsWindow, "settings");
      }
    });
    settingsWindow.webContents.on("will-navigate", (event, url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          event.preventDefault();
          shell.openExternal(url);
        }
      } catch {
      }
    });
    settingsWindow.webContents.on("render-process-gone", (_event, details) => {
      console.error(`[desktop] settings renderer 崩溃: ${details.reason} (code: ${details.exitCode})`);
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.destroy();
      }
      settingsWindow = null;
    });
    settingsWindow.on("closed", () => {
      if (preferredPrimaryWindowKind === "settings") {
        preferredPrimaryWindowKind = "main";
      }
      settingsWindowInitialNavigationTarget = null;
      settingsWindowContentStamp = null;
      settingsWindow = null;
    });
  }
  function _showSkillViewer(skillInfo) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("show-skill-viewer", skillInfo);
      mainWindow.show();
      mainWindow.focus();
    }
  }
  function scanSkillDir(dir, rootDir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).sort((a, b) => {
      if (a.name === "SKILL.md") return -1;
      if (b.name === "SKILL.md") return 1;
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    return entries.map((e) => {
      const fullPath = path.join(dir, e.name);
      if (e.isDirectory()) {
        return { name: e.name, path: fullPath, isDir: true, children: scanSkillDir(fullPath) };
      }
      return { name: e.name, path: fullPath, isDir: false };
    });
  }
  function createBrowserViewerWindow(opts = {}) {
    const shouldShow = opts.show !== false;
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      if (shouldShow) {
        browserViewerWindow.show();
        browserViewerWindow.focus();
        _updateBrowserViewBounds();
        if (_browserWebView) {
          setTimeout(() => {
            if (_browserWebView) _browserWebView.webContents.focus();
          }, 50);
        }
      }
      return;
    }
    browserViewerWindow = new BrowserWindow({
      width: 1200,
      height: 1080,
      minWidth: 480,
      minHeight: 360,
      title: "Browser",
      frame: false,
      backgroundColor: THEME_BG[_browserViewerTheme] || THEME_BG["warm-paper"],
      hasShadow: true,
      show: shouldShow,
      acceptFirstMouse: true,
      // macOS: 第一次点击不仅激活窗口，还穿透到内容
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    loadWindowURL(browserViewerWindow, "browser-viewer");
    browserViewerWindow.webContents.on("did-finish-load", () => {
      if (_browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        try {
          browserViewerWindow.contentView.removeChildView(_browserWebView);
        } catch {
        }
        browserViewerWindow.contentView.addChildView(_browserWebView);
        _updateBrowserViewBounds();
        const url = _browserWebView.webContents.getURL();
        if (url) _notifyViewerUrl(url);
        console.log("[browser-viewer] did-finish-load: view 已挂载, bounds:", _browserWebView.getBounds());
        setTimeout(() => {
          if (_browserWebView) {
            _browserWebView.webContents.focus();
            console.log("[browser-viewer] delayed focus applied, isFocused:", _browserWebView.webContents.isFocused());
          }
        }, 200);
      }
    });
    browserViewerWindow.on("resize", () => _updateBrowserViewBounds());
    browserViewerWindow.on("show", () => _updateBrowserViewBounds());
    browserViewerWindow.on("focus", () => {
      markPreferredPrimaryWindow("browser");
      if (_browserWebView) {
        _browserWebView.webContents.focus();
        console.log("[browser-viewer] window focus → view.focus(), isFocused:", _browserWebView.webContents.isFocused());
      }
    });
    browserViewerWindow.on("close", (e) => {
      if (!isQuitting && _browserWebView) {
        e.preventDefault();
        browserViewerWindow.hide();
      }
    });
    browserViewerWindow.on("closed", () => {
      if (preferredPrimaryWindowKind === "browser") {
        preferredPrimaryWindowKind = "main";
      }
      browserViewerWindow = null;
    });
  }
  const SNAPSHOT_SCRIPT = `(function() {
  var ref = 0;
  var MAX_TREE = 30000;
  document.querySelectorAll('[data-hana-ref]').forEach(function(el) {
    el.removeAttribute('data-hana-ref');
  });

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function isInteractive(el) {
    var t = el.tagName;
    if (['A','BUTTON','INPUT','TEXTAREA','SELECT','DETAILS','SUMMARY'].indexOf(t) !== -1) return true;
    var r = el.getAttribute('role');
    if (r && ['button','link','menuitem','tab','checkbox','radio','textbox','combobox','listbox','option','switch','slider','treeitem'].indexOf(r) !== -1) return true;
    if (el.onclick || el.hasAttribute('onclick')) return true;
    if (el.contentEditable === 'true') return true;
    if (el.tabIndex > 0) return true;
    try { if (window.getComputedStyle(el).cursor === 'pointer' && !el.closest('a,button')) return true; } catch(e) {}
    return false;
  }

  function directText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent;
    }
    return t.trim().replace(/\\s+/g, ' ').slice(0, 80);
  }

  // 结构签名：只看直接子元素的 tag 序列，用于检测同构兄弟
  function sig(el) {
    if (el.nodeType !== 1 || !isVisible(el)) return null;
    var tag = el.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return null;
    var s = tag;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.nodeType === 1 && isVisible(c) && ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(c.tagName) === -1) {
        s += ',' + c.tagName;
      }
    }
    return s;
  }

  // 单行紧凑格式：链接 | 按钮 | 文本1 · 文本2
  function compact(el, depth) {
    var links = [], ctrls = [], texts = [];
    function collect(node) {
      if (node.nodeType !== 1 || !isVisible(node)) return;
      var tag = node.tagName;
      if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return;
      if (isInteractive(node)) {
        ref++;
        node.setAttribute('data-hana-ref', String(ref));
        var name = node.getAttribute('aria-label') || node.title || node.placeholder
          || (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) || node.value || '';
        if (tag === 'A' || node.getAttribute('role') === 'link') {
          links.push('[' + ref + '] "' + name + '"');
        } else {
          ctrls.push('[' + ref + '] ' + name);
        }
        return; // 交互元素的子树已被 textContent 捕获，不再递归
      }
      var txt = directText(node);
      if (txt && txt.length > 2) texts.push(txt);
      for (var i = 0; i < node.children.length; i++) collect(node.children[i]);
    }
    collect(el);
    if (!links.length && !ctrls.length && !texts.length) return '';
    var pad = '';
    for (var i = 0; i < depth; i++) pad += '  ';
    var parts = links.concat(ctrls);
    var line = parts.join(' | ');
    if (texts.length) line += (line ? ' | ' : '') + texts.join(' \\u00b7 ');
    return pad + line + '\\n';
  }

  // 分组遍历：连续 ≥3 个同构兄弟用 compact，其余正常 walk
  function walkChildren(el, depth) {
    var out = '';
    var children = [], sigs = [];
    for (var i = 0; i < el.children.length; i++) {
      children.push(el.children[i]);
      sigs.push(sig(el.children[i]));
    }
    var g = 0;
    while (g < children.length) {
      if (!sigs[g]) { out += walk(children[g], depth); g++; continue; }
      var end = g + 1;
      while (end < children.length && sigs[end] === sigs[g]) end++;
      if (end - g >= 3) {
        for (var k = g; k < end; k++) out += compact(children[k], depth);
      } else {
        for (var k = g; k < end; k++) out += walk(children[k], depth);
      }
      g = end;
    }
    return out;
  }

  function walk(el, depth) {
    if (el.nodeType !== 1) return '';
    if (!isVisible(el)) return '';
    var tag = el.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return '';

    var out = '';
    var pad = '';
    for (var i = 0; i < depth; i++) pad += '  ';

    var interactive = isInteractive(el);
    if (interactive) {
      ref++;
      el.setAttribute('data-hana-ref', String(ref));
      var role = el.getAttribute('role') || tag.toLowerCase();
      var name = el.getAttribute('aria-label') || el.title || el.placeholder || directText(el) || el.value || '';
      var label = name.slice(0, 60);

      var flags = [];
      if (el.type && el.type !== 'submit' && tag === 'INPUT') flags.push(el.type);
      if (tag === 'INPUT' && el.value) flags.push('value="' + el.value.slice(0,30) + '"');
      if (el.checked) flags.push('checked');
      if (el.disabled) flags.push('disabled');
      if (el.getAttribute('aria-selected') === 'true') flags.push('selected');
      if (el.getAttribute('aria-expanded')) flags.push('expanded=' + el.getAttribute('aria-expanded'));
      if (tag === 'A' && el.href) flags.push('href="' + el.href.slice(0,80) + '"');

      var extra = flags.length ? ' (' + flags.join(', ') + ')' : '';
      out += pad + '[' + ref + '] ' + role + ' "' + label + '"' + extra + '\\n';
    } else if (/^H[1-6]/.test(tag)) {
      var hText = directText(el);
      if (hText) out += pad + tag.toLowerCase() + ': ' + hText + '\\n';
    } else if (tag === 'IMG') {
      out += pad + 'img "' + (el.alt || '').slice(0,40) + '"\\n';
    } else if (['P','SPAN','DIV','LI','TD','TH','LABEL'].indexOf(tag) !== -1) {
      var txt = directText(el);
      if (txt && txt.length > 2 && !el.querySelector('a,button,input,textarea,select,[role]')) {
        out += pad + 'text: ' + txt + '\\n';
      }
    }

    out += walkChildren(el, interactive ? depth + 1 : depth);
    return out;
  }

  var tree = walk(document.body, 0);

  // 硬上限：超过 MAX_TREE 时保留头部 80% + 尾部 20%，在行边界截断
  if (tree.length > MAX_TREE) {
    var h = tree.lastIndexOf('\\n', Math.floor(MAX_TREE * 0.8));
    if (h < MAX_TREE * 0.4) h = Math.floor(MAX_TREE * 0.8);
    var tl = tree.indexOf('\\n', tree.length - Math.floor(MAX_TREE * 0.2));
    if (tl < 0) tl = tree.length - Math.floor(MAX_TREE * 0.2);
    tree = tree.slice(0, h) + '\\n\\n[... ' + (tl - h) + ' chars omitted ...]\\n\\n' + tree.slice(tl);
  }

  return {
    title: document.title,
    currentUrl: location.href,
    text: 'Page: ' + document.title + '\\nURL: ' + location.href + '\\n\\n' + tree
  };
})()`;
  function _ensureBrowser() {
    if (!_browserWebView) throw new Error("Browser not launched. Call start first.");
  }
  function _delay(ms) {
    return new Promise(function(r) {
      setTimeout(r, ms);
    });
  }
  function _updateBrowserViewBounds() {
    if (!_browserWebView || !browserViewerWindow || browserViewerWindow.isDestroyed()) return;
    const [width, height] = browserViewerWindow.getContentSize();
    const mx = 8, mt2 = 4, mb = 8;
    const bounds = {
      x: mx,
      y: TITLEBAR_HEIGHT + mt2,
      width: Math.max(0, width - mx * 2),
      height: Math.max(0, height - TITLEBAR_HEIGHT - mt2 - mb)
    };
    if (bounds.width === 0 || bounds.height === 0) {
      console.warn("[browser] bounds 计算为零:", { contentSize: [width, height], bounds, visible: browserViewerWindow.isVisible() });
    }
    _browserWebView.setBounds(bounds);
  }
  function _notifyViewerUrl(url) {
    if (browserViewerWindow && !browserViewerWindow.isDestroyed() && _browserWebView) {
      browserViewerWindow.webContents.send("browser-update", {
        url,
        title: _browserWebView.webContents.getTitle(),
        canGoBack: _browserWebView.webContents.canGoBack(),
        canGoForward: _browserWebView.webContents.canGoForward()
      });
    }
  }
  async function handleBrowserCommand(cmd, params) {
    switch (cmd) {
      // ── launch ──
      case "launch": {
        if (_browserWebView) return {};
        const ses = session.fromPartition("persist:hana-browser");
        const view = new WebContentsView({
          webPreferences: {
            session: ses,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        });
        view.webContents.on("did-navigate", (_e, url) => _notifyViewerUrl(url));
        view.webContents.on("did-navigate-in-page", (_e, url) => _notifyViewerUrl(url));
        view.webContents.setWindowOpenHandler(({ url }) => {
          if (isAllowedBrowserUrl(url)) {
            view.webContents.loadURL(url);
          }
          return { action: "deny" };
        });
        view.webContents.on("page-title-updated", () => {
          _notifyViewerUrl(view.webContents.getURL());
        });
        view.setBorderRadius(10);
        _browserWebView = view;
        _currentBrowserSession = params.sessionPath || null;
        if (_currentBrowserSession) {
          _browserViews.set(_currentBrowserSession, view);
        }
        createBrowserViewerWindow({ show: false });
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          try {
            browserViewerWindow.contentView.removeChildView(_browserWebView);
          } catch {
          }
          browserViewerWindow.contentView.addChildView(_browserWebView);
          _updateBrowserViewBounds();
          console.log("[browser] launch: view 已挂载 (silent), bounds:", _browserWebView.getBounds());
          setTimeout(() => {
            if (_browserWebView) {
              _browserWebView.webContents.focus();
            }
          }, 300);
        }
        return {};
      }
      // ── close ──（真正销毁当前浏览器实例）
      case "close": {
        if (_browserWebView) {
          if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
            try {
              browserViewerWindow.contentView.removeChildView(_browserWebView);
            } catch {
            }
          }
          _browserWebView.webContents.close();
          if (_currentBrowserSession) {
            _browserViews.delete(_currentBrowserSession);
          }
          _browserWebView = null;
          _currentBrowserSession = null;
        }
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          browserViewerWindow.webContents.send("browser-update", { running: false });
        }
        return {};
      }
      // ── suspend ──（从窗口摘下来，但不销毁，页面状态完全保留）
      case "suspend": {
        if (_browserWebView) {
          if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
            try {
              browserViewerWindow.contentView.removeChildView(_browserWebView);
            } catch {
            }
          }
          _browserWebView = null;
          _currentBrowserSession = null;
        }
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          browserViewerWindow.webContents.send("browser-update", { running: false });
        }
        return {};
      }
      // ── resume ──（把挂起的 view 挂回窗口，但不自动弹出）
      case "resume": {
        const sp = params.sessionPath;
        if (!sp || !_browserViews.has(sp)) {
          return { found: false };
        }
        const view = _browserViews.get(sp);
        _browserWebView = view;
        _currentBrowserSession = sp;
        createBrowserViewerWindow({ show: false });
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          browserViewerWindow.contentView.addChildView(view);
          _updateBrowserViewBounds();
          view.webContents.focus();
        }
        const url = view.webContents.getURL();
        if (url) _notifyViewerUrl(url);
        return { found: true, url };
      }
      // ── navigate ──
      case "navigate": {
        if (!isAllowedBrowserUrl(params.url)) {
          throw new Error("Only http/https URLs are allowed");
        }
        _ensureBrowser();
        const wc = _browserWebView.webContents;
        await wc.loadURL(params.url);
        await _delay(500);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { url: snap.currentUrl, title: snap.title, snapshot: snap.text };
      }
      // ── snapshot ──
      case "snapshot": {
        _ensureBrowser();
        const snap = await _browserWebView.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, text: snap.text };
      }
      // ── screenshot ──
      case "screenshot": {
        _ensureBrowser();
        const img = await _browserWebView.webContents.capturePage();
        const jpeg = img.toJPEG(75);
        return { base64: jpeg.toString("base64") };
      }
      // ── thumbnail ──
      case "thumbnail": {
        _ensureBrowser();
        const img = await _browserWebView.webContents.capturePage();
        const resized = img.resize({ width: 400 });
        const jpeg = resized.toJPEG(60);
        return { base64: jpeg.toString("base64") };
      }
      // ── click ──
      case "click": {
        _ensureBrowser();
        const wc = _browserWebView.webContents;
        const clickRef = Number(params.ref);
        await wc.executeJavaScript(
          `(function(){ var el = document.querySelector('[data-hana-ref="` + clickRef + `"]'); if (!el) throw new Error('Element [` + clickRef + "] not found'); el.scrollIntoView({block:'center'}); el.click(); })()"
        );
        await _delay(800);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, text: snap.text };
      }
      // ── type ──
      case "type": {
        _ensureBrowser();
        const wc = _browserWebView.webContents;
        if (params.ref != null) {
          const typeRef = Number(params.ref);
          await wc.executeJavaScript(
            `(function(){ var el = document.querySelector('[data-hana-ref="` + typeRef + `"]'); if (!el) throw new Error('Element [` + typeRef + "] not found'); el.scrollIntoView({block:'center'}); el.focus(); if (el.select) el.select(); })()"
          );
          await _delay(100);
        }
        await wc.insertText(params.text);
        if (params.pressEnter) {
          await _delay(100);
          wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
          await _delay(800);
        }
        await _delay(300);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, text: snap.text };
      }
      // ── scroll ──
      case "scroll": {
        _ensureBrowser();
        const wc = _browserWebView.webContents;
        const delta = (params.direction === "up" ? -1 : 1) * (params.amount || 3) * 300;
        await wc.executeJavaScript("window.scrollBy({top:" + delta + ",behavior:'smooth'})");
        await _delay(500);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { text: snap.text };
      }
      // ── select ──
      case "select": {
        _ensureBrowser();
        const wc = _browserWebView.webContents;
        const selRef = Number(params.ref);
        const safeValue = JSON.stringify(params.value);
        await wc.executeJavaScript(
          `(function(){ var el = document.querySelector('[data-hana-ref="` + selRef + `"]'); if (!el) throw new Error('Element [` + selRef + "] not found'); el.value = " + safeValue + "; el.dispatchEvent(new Event('change',{bubbles:true})); })()"
        );
        await _delay(300);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { text: snap.text };
      }
      // ── pressKey ──
      case "pressKey": {
        _ensureBrowser();
        const wc = _browserWebView.webContents;
        const parts = params.key.split("+");
        const keyCode = parts[parts.length - 1];
        const modifiers = parts.slice(0, -1).map(function(m) {
          return m.toLowerCase();
        });
        const keyMap = { Enter: "Return", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Space: "Space" };
        const mappedKey = keyMap[keyCode] || keyCode;
        wc.sendInputEvent({ type: "keyDown", keyCode: mappedKey, modifiers });
        wc.sendInputEvent({ type: "keyUp", keyCode: mappedKey, modifiers });
        await _delay(300);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { text: snap.text };
      }
      // ── wait ──
      case "wait": {
        _ensureBrowser();
        const timeout = Math.min(params.timeout || 5e3, 1e4);
        await _delay(timeout);
        const snap = await _browserWebView.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
        return { text: snap.text };
      }
      // ── evaluate ──
      case "evaluate": {
        if (!params.expression || params.expression.length > 1e4) {
          throw new Error("Expression too long (max 10000 chars)");
        }
        console.log(`[browser:evaluate] ${params.expression.slice(0, 200)}${params.expression.length > 200 ? "..." : ""}`);
        _ensureBrowser();
        const result = await _browserWebView.webContents.executeJavaScript(params.expression);
        const serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { value: serialized || "undefined" };
      }
      // ── show ──
      case "show": {
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          browserViewerWindow.show();
          browserViewerWindow.focus();
          if (_browserWebView) {
            _browserWebView.webContents.focus();
            setTimeout(() => {
              if (_browserWebView) _browserWebView.webContents.focus();
            }, 100);
          }
        } else if (_browserWebView) {
          createBrowserViewerWindow();
        }
        return {};
      }
      // ── destroyView ──（销毁指定 session 的挂起 view）
      case "destroyView": {
        const sp = params.sessionPath;
        if (sp && _browserViews.has(sp)) {
          const view = _browserViews.get(sp);
          if (view === _browserWebView) {
            if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
              try {
                browserViewerWindow.contentView.removeChildView(view);
              } catch {
              }
            }
            _browserWebView = null;
            _currentBrowserSession = null;
            if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
              browserViewerWindow.webContents.send("browser-update", { running: false });
              browserViewerWindow.hide();
            }
          }
          view.webContents.close();
          _browserViews.delete(sp);
        }
        return {};
      }
      default:
        throw new Error("Unknown browser command: " + cmd);
    }
  }
  function setupBrowserCommands() {
    if (!serverPort || !serverToken) return;
    const WebSocket = require$$8;
    const url = `ws://127.0.0.1:${serverPort}/internal/browser`;
    const protocols = serverToken ? ["hana-browser", `token.${serverToken}`] : ["hana-browser"];
    let ws;
    function connect() {
      ws = new WebSocket(url, protocols);
      ws.on("open", () => {
        console.log("[desktop] Browser control WS connected");
      });
      ws.on("message", async (data) => {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg?.type !== "browser-cmd") return;
        const { id, cmd, params } = msg;
        const _bLog = (line) => {
          try {
            require("fs").appendFileSync(require("path").join(require("os").homedir(), ".lynn", "browser-cmd.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`);
          } catch {
          }
        };
        _bLog(`→ received cmd=${cmd} id=${id}`);
        try {
          const result = await handleBrowserCommand(cmd, params || {});
          _bLog(`✓ cmd=${cmd} result=${JSON.stringify(result).slice(0, 200)} wsReady=${ws.readyState}`);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "browser-result", id, result }));
            _bLog(`✓ sent result`);
          } else {
            _bLog(`✗ ws not ready (${ws.readyState}), result dropped`);
          }
        } catch (err) {
          _bLog(`✗ cmd=${cmd} error=${err.message}`);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "browser-result", id, error: err.message }));
          }
        }
      });
      ws.on("close", () => {
        if (!isQuitting) {
          setTimeout(connect, 2e3);
        }
      });
      ws.on("error", () => {
      });
    }
    connect();
  }
  async function completeOnboardingAndOpenMain({ markSetupComplete = true } = {}) {
    const prefsPath = path.join(lynnHome, "user", "preferences.json");
    if (markSetupComplete) {
      try {
        let prefs = {};
        try {
          prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
        } catch {
        }
        prefs.setupComplete = true;
        fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
      } catch (err) {
        console.error("[desktop] Failed to write setupComplete:", err);
      }
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow();
    }
    const ready = await waitForMainWindowReady();
    if (!ready && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.show();
      } catch {
      }
      return false;
    }
    return true;
  }
  function createOnboardingWindow(query = {}) {
    onboardingWindow = new BrowserWindow({
      width: 560,
      height: 780,
      resizable: false,
      fullscreenable: false,
      maximizable: false,
      title: "Lynn",
      ...titleBarOpts({ x: 16, y: 16 }),
      backgroundColor: "#F4F0E4",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    loadWindowURL(onboardingWindow, "onboarding", { query });
    onboardingWindow.once("ready-to-show", () => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
      }
      onboardingWindow.show();
    });
    onboardingWindow.on("focus", () => {
      markPreferredPrimaryWindow("onboarding");
    });
    onboardingWindow.on("closed", () => {
      if (preferredPrimaryWindowKind === "onboarding") {
        preferredPrimaryWindowKind = "main";
      }
      const shouldSkipIntoApp = query.preview !== "1" && !forceQuitApp && (!mainWindow || mainWindow.isDestroyed());
      onboardingWindow = null;
      if (shouldSkipIntoApp) {
        void completeOnboardingAndOpenMain({ markSetupComplete: true });
      }
    });
  }
  async function checkForUpdates() {
    await checkForUpdatesAuto();
  }
  wrapIpcHandler("get-server-port", () => serverPort);
  wrapIpcHandler("get-server-token", () => serverToken);
  wrapIpcHandler("get-app-version", () => app.getVersion());
  const { getState: getUpdateState } = requireAutoUpdater();
  wrapIpcHandler("check-update", () => {
    const s = getUpdateState();
    if (s.status === "available" || s.status === "downloaded") {
      return { version: s.version, downloadUrl: s.downloadUrl || s.releaseUrl };
    }
    return null;
  });
  wrapIpcHandler("open-settings", (_event, tab, theme) => createSettingsWindow(tab, theme));
  wrapIpcHandler("get-initial-settings-navigation-target", (event) => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return null;
    if (event.sender !== settingsWindow.webContents) return null;
    const target = settingsWindowInitialNavigationTarget;
    settingsWindowInitialNavigationTarget = null;
    return target;
  });
  wrapIpcHandler("open-browser-viewer", (_event, theme) => {
    if (theme) _browserViewerTheme = theme;
    createBrowserViewerWindow();
  });
  wrapIpcHandler("browser-go-back", () => {
    if (_browserWebView) _browserWebView.webContents.goBack();
  });
  wrapIpcHandler("browser-go-forward", () => {
    if (_browserWebView) _browserWebView.webContents.goForward();
  });
  wrapIpcHandler("browser-reload", () => {
    if (_browserWebView) _browserWebView.webContents.reload();
  });
  wrapIpcHandler("close-browser-viewer", () => {
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.close();
  });
  wrapIpcHandler("browser-emergency-stop", () => {
    if (_browserWebView) {
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        try {
          browserViewerWindow.contentView.removeChildView(_browserWebView);
        } catch {
        }
      }
      _browserWebView.webContents.close();
      if (_currentBrowserSession) {
        _browserViews.delete(_currentBrowserSession);
      }
      _browserWebView = null;
      _currentBrowserSession = null;
    }
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.webContents.send("browser-update", { running: false });
    }
  });
  let editorWindow = null;
  let _editorFileData = null;
  wrapIpcHandler("open-editor-window", (event, data) => {
    if (!data?.filePath || !canWritePath(event.sender, data.filePath).allowed) return;
    _editorFileData = data;
    if (editorWindow && !editorWindow.isDestroyed()) {
      grantWebContentsAccess(editorWindow, data.filePath, "readwrite");
      editorWindow.show();
      editorWindow.focus();
      editorWindow.webContents.send("editor-load", data);
      return;
    }
    const isDark = nativeTheme.shouldUseDarkColors;
    const theme = isDark ? "midnight" : "warm-paper";
    editorWindow = new BrowserWindow({
      width: 720,
      height: 800,
      minWidth: 400,
      minHeight: 300,
      title: data.title || "Editor",
      frame: false,
      backgroundColor: THEME_BG[theme] || THEME_BG["warm-paper"],
      hasShadow: true,
      show: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    grantWebContentsAccess(editorWindow, data.filePath, "readwrite");
    loadWindowURL(editorWindow, "editor-window");
    editorWindow.webContents.on("did-finish-load", () => {
      if (_editorFileData && editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.webContents.send("editor-load", _editorFileData);
      }
    });
    editorWindow.on("focus", () => {
      markPreferredPrimaryWindow("editor");
    });
    editorWindow.on("close", (e) => {
      if (!isQuitting) {
        e.preventDefault();
        editorWindow.hide();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("editor-detached", false);
        }
      }
    });
    editorWindow.on("closed", () => {
      if (preferredPrimaryWindowKind === "editor") {
        preferredPrimaryWindowKind = "main";
      }
      editorWindow = null;
      _editorFileData = null;
      for (const [, watcher] of _fileWatchers) watcher.close();
      _fileWatchers.clear();
    });
  });
  wrapIpcHandler("editor-dock", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("editor-detached", false);
      if (_editorFileData) {
        mainWindow.webContents.send("editor-dock-file", _editorFileData);
      }
    }
    if (editorWindow && !editorWindow.isDestroyed()) {
      editorWindow.hide();
    }
  });
  wrapIpcHandler("editor-close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("editor-detached", false);
    }
    if (editorWindow && !editorWindow.isDestroyed()) {
      editorWindow.hide();
    }
  });
  wrapIpcOn("settings-changed", (_event, type2, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("settings-changed", type2, data);
    }
    if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.webContents.id !== _event.sender.id) {
      settingsWindow.webContents.send("settings-changed", type2, data);
    }
    if (type2 === "theme-changed" && data?.theme) {
      const name = data.theme;
      _browserViewerTheme = name === "auto" ? nativeTheme.shouldUseDarkColors ? "midnight" : "warm-paper" : name;
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.webContents.send("settings-changed", type2, data);
      }
    }
    if (type2 === "locale-changed") {
      resetMainI18n();
      if (tray && !tray.isDestroyed()) {
        const buildMenu = () => Menu.buildFromTemplate([
          { label: mt("tray.show", null, "Show Lynn"), click: () => showPrimaryWindow() },
          { label: mt("tray.settings", null, "Settings"), click: () => createSettingsWindow() },
          { type: "separator" },
          { label: mt("tray.quit", null, "Quit"), click: () => {
            isQuitting = true;
            app.quit();
          } }
        ]);
        tray.setContextMenu(buildMenu());
      }
    }
  });
  wrapIpcHandler("get-avatar-path", (_event, role) => {
    if (role !== "agent" && role !== "user") return null;
    const agentId = getCurrentAgentId();
    const baseDir = role === "user" ? path.join(lynnHome, "user") : agentId ? path.join(lynnHome, "agents", agentId) : null;
    if (!baseDir) return null;
    const avatarDir = path.join(baseDir, "avatars");
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      const p = path.join(avatarDir, `${role}.${ext}`);
      if (fs.existsSync(p)) return p;
    }
    return null;
  });
  wrapIpcHandler("get-splash-info", () => {
    try {
      const agentId = getCurrentAgentId();
      if (!agentId) return { agentName: null, locale: "zh-CN", yuan: "hanako" };
      const configPath = path.join(lynnHome, "agents", agentId, "config.yaml");
      const text = fs.readFileSync(configPath, "utf-8");
      const agentMatch = text.match(/^agent:\s*\n\s+name:\s*([^#\n]+)/m);
      const localeMatch = text.match(/^locale:\s*(.+)/m);
      const yuanMatch = text.match(/^\s+yuan:\s*([^#\n]+)/m);
      return {
        agentName: agentMatch?.[1]?.trim() || null,
        locale: localeMatch?.[1]?.trim() || null,
        yuan: yuanMatch?.[1]?.trim() || "hanako"
      };
    } catch {
      return { agentName: null, locale: "zh-CN", yuan: "hanako" };
    }
  });
  wrapIpcHandler("select-folder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: mt("dialog.selectFolder", null, "Select Working Folder")
    });
    if (result.canceled || !result.filePaths.length) return null;
    const selectedPath = result.filePaths[0];
    grantWebContentsAccess(event.sender, selectedPath, "readwrite");
    return selectedPath;
  });
  wrapIpcHandler("get-onboarding-defaults", () => {
    const desktopRoot = path.join(os.homedir(), "Desktop");
    const workspacePath = path.join(desktopRoot, "Lynn");
    const installRoot = path.resolve(process.cwd());
    try {
      fs.mkdirSync(workspacePath, { recursive: true });
    } catch {
    }
    return {
      workspacePath,
      desktopRoot,
      installRoot,
      trustedRoots: Array.from(new Set([desktopRoot, workspacePath].filter(Boolean)))
    };
  });
  wrapIpcHandler("select-skill", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile", "openDirectory"],
      title: mt("dialog.selectSkill", null, "Select Skill"),
      filters: [
        { name: "Skill", extensions: ["zip", "skill"] },
        { name: "All Files", extensions: ["*"] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return null;
    const selectedPath = result.filePaths[0];
    grantWebContentsAccess(event.sender, selectedPath, "read");
    return selectedPath;
  });
  wrapIpcHandler("open-skill-viewer", (event, data) => {
    if (!data) return;
    if (data.skillPath) {
      const skillPathAccess = canReadPath(event.sender, data.skillPath);
      if (!skillPathAccess.allowed) return;
    }
    if (data.baseDir) {
      const baseDirAccess = canReadPath(event.sender, data.baseDir);
      if (!baseDirAccess.allowed) return;
    }
    if (data.skillPath && path.isAbsolute(data.skillPath)) {
      const fileExt = path.extname(data.skillPath).toLowerCase();
      if (fileExt === ".skill" || fileExt === ".zip") {
        const baseName = path.basename(data.skillPath, fileExt);
        const installedDir = path.join(lynnHome, "skills", baseName);
        if (fs.existsSync(path.join(installedDir, "SKILL.md"))) {
          grantWebContentsAccess(mainWindow, installedDir, "read");
          _showSkillViewer({ name: baseName, baseDir: installedDir, installed: false });
          return;
        }
        if (!fs.existsSync(data.skillPath)) {
          console.warn("[skill-viewer] .skill file not found:", data.skillPath);
          return;
        }
        try {
          const { execFileSync: execFileSync2 } = require("child_process");
          const tmpDir = path.join(app.getPath("temp"), "hana-skill-preview-" + Date.now());
          fs.mkdirSync(tmpDir, { recursive: true });
          if (process.platform === "win32") {
            execFileSync2("powershell.exe", [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `Expand-Archive -Path '${data.skillPath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`
            ], { stdio: "ignore", windowsHide: true });
          } else {
            execFileSync2("unzip", ["-o", "-q", data.skillPath, "-d", tmpDir]);
          }
          let skillDir = null;
          if (fs.existsSync(path.join(tmpDir, "SKILL.md"))) {
            skillDir = tmpDir;
          } else {
            const sub = fs.readdirSync(tmpDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."));
            const found = sub.find((e) => fs.existsSync(path.join(tmpDir, e.name, "SKILL.md")));
            if (found) skillDir = path.join(tmpDir, found.name);
          }
          if (!skillDir) return;
          const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m);
          const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : baseName;
          grantWebContentsAccess(mainWindow, skillDir, "read");
          _showSkillViewer({ name, baseDir: skillDir, installed: false });
        } catch (err) {
          console.error("[skill-viewer] Failed to extract .skill file:", err.message);
        }
        return;
      }
    }
    if (!data.baseDir || !path.isAbsolute(data.baseDir)) return;
    grantWebContentsAccess(mainWindow, data.baseDir, "read");
    _showSkillViewer(data);
  });
  wrapIpcHandler("skill-viewer-list-files", (event, baseDir) => {
    const access = canReadPath(event.sender, baseDir);
    if (!baseDir || !path.isAbsolute(baseDir) || !access.allowed) return [];
    try {
      if (!fs.statSync(access.canonical).isDirectory()) return [];
      return scanSkillDir(access.canonical, access.canonical);
    } catch {
      return [];
    }
  });
  wrapIpcHandler("skill-viewer-read-file", (event, filePath) => {
    const access = canReadPath(event.sender, filePath);
    if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
    try {
      const stat = fs.statSync(access.canonical);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
      return fs.readFileSync(access.canonical, "utf-8");
    } catch {
      return null;
    }
  });
  wrapIpcHandler("close-skill-viewer", () => {
  });
  wrapIpcHandler("open-folder", (event, folderPath) => {
    const access = canReadPath(event.sender, folderPath);
    if (!folderPath || !path.isAbsolute(folderPath) || !access.allowed) return;
    try {
      if (!fs.statSync(access.canonical).isDirectory()) return;
    } catch {
      return;
    }
    shell.openPath(access.canonical);
  });
  wrapIpcOn("start-drag", async (event, filePaths) => {
    const requestedPaths = Array.isArray(filePaths) ? filePaths : [filePaths];
    const paths = requestedPaths.map((filePath) => canReadPath(event.sender, filePath)).filter((result) => result.allowed && result.canonical).map((result) => result.canonical);
    if (paths.length === 0) return;
    let icon;
    try {
      icon = await app.getFileIcon(paths[0], { size: "small" });
    } catch {
      icon = nativeImage.createFromDataURL(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg=="
      );
    }
    if (paths.length === 1) {
      event.sender.startDrag({ file: paths[0], icon });
    } else {
      event.sender.startDrag({ files: paths, icon });
    }
  });
  wrapIpcHandler("show-in-finder", (event, filePath) => {
    const access = canReadPath(event.sender, filePath);
    if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return;
    shell.showItemInFolder(access.canonical);
  });
  wrapIpcHandler("open-file", (event, filePath) => {
    const access = canReadPath(event.sender, filePath);
    if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return;
    try {
      if (!fs.statSync(access.canonical).isFile()) return;
    } catch {
      return;
    }
    shell.openPath(access.canonical);
  });
  wrapIpcHandler("open-html-in-browser", async (_event, html, title) => {
    if (typeof html !== "string" || !html) return;
    const safeTitle = String(title || "lynn-report").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
    const tmpFile = path.join(os.tmpdir(), `${safeTitle}-${Date.now()}.html`);
    try {
      fs.writeFileSync(tmpFile, html, "utf-8");
      await shell.openPath(tmpFile);
    } catch (err) {
      log.error("[open-html-in-browser]", err.message || err);
    }
  });
  wrapIpcHandler("save-file-dialog", async (event, opts = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, {
      title: opts.title || mt("common.save", null, "Save"),
      defaultPath: opts.defaultPath,
      filters: Array.isArray(opts.filters) ? opts.filters : void 0
    });
    if (result.canceled || !result.filePath) return null;
    grantWebContentsAccess(event.sender, result.filePath, "readwrite");
    return result.filePath;
  });
  wrapIpcHandler("open-external", (_event, url) => {
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        shell.openExternal(url);
      }
    } catch {
    }
  });
  wrapIpcHandler("confirm-action", async (event, opts = {}) => {
    const sender = event.sender;
    const webContents = sender?.isDestroyed?.() ? null : sender;
    if (!webContents) return false;
    const requestId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return await new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ipcMain.removeListener(`confirm-action-response:${requestId}`, handleResponse);
        resolve(false);
      }, 5 * 60 * 1e3);
      const handleResponse = (_respEvent, payload = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        ipcMain.removeListener(`confirm-action-response:${requestId}`, handleResponse);
        resolve(payload.approved === true);
      };
      ipcMain.once(`confirm-action-response:${requestId}`, handleResponse);
      try {
        webContents.send("confirm-action-request", {
          requestId,
          title: opts.title || "Lynn",
          message: opts.message || mt("common.confirm", null, "Confirm"),
          detail: opts.detail || "",
          confirmLabel: opts.confirmLabel || mt("common.confirm", null, "Confirm"),
          cancelLabel: opts.cancelLabel || mt("common.cancel", null, "Cancel"),
          tone: opts.tone === "danger" ? "danger" : "default"
        });
      } catch (err) {
        clearTimeout(timeout);
        ipcMain.removeListener(`confirm-action-response:${requestId}`, handleResponse);
        resolve(false);
      }
    });
  });
  wrapIpcHandler("read-file", (event, filePath) => {
    const access = canReadPath(event.sender, filePath);
    if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
    try {
      const stat = fs.statSync(access.canonical);
      if (!stat.isFile()) return null;
      if (stat.size > 5 * 1024 * 1024) return null;
      return fs.readFileSync(access.canonical, "utf-8");
    } catch {
      return null;
    }
  });
  wrapIpcHandler("write-file", (event, filePath, content) => {
    const access = canWritePath(event.sender, filePath);
    if (!filePath || !path.isAbsolute(filePath) || !access.allowed || typeof content !== "string") return false;
    try {
      fs.writeFileSync(access.canonical, content, "utf-8");
      return true;
    } catch {
      return false;
    }
  });
  const _fileWatchers = /* @__PURE__ */ new Map();
  wrapIpcHandler("watch-file", (event, filePath) => {
    const access = canReadPath(event.sender, filePath);
    if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return false;
    if (_fileWatchers.has(access.canonical)) {
      _fileWatchers.get(access.canonical).close();
      _fileWatchers.delete(access.canonical);
    }
    try {
      const watcher = fs.watch(access.canonical, { persistent: false }, (eventType) => {
        if (eventType === "change") {
          const win = BrowserWindow.fromWebContents(event.sender);
          if (win && !win.isDestroyed()) {
            win.webContents.send("file-changed", access.canonical);
          }
        }
      });
      _fileWatchers.set(access.canonical, watcher);
      return true;
    } catch {
      return false;
    }
  });
  wrapIpcHandler("unwatch-file", (_event, filePath) => {
    const canonical = resolveCanonicalPath(filePath);
    if (canonical && _fileWatchers.has(canonical)) {
      _fileWatchers.get(canonical).close();
      _fileWatchers.delete(canonical);
    }
    return true;
  });
  wrapIpcHandler("read-file-base64", (event, filePath) => {
    const access = canReadPath(event.sender, filePath);
    if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
    try {
      const stat = fs.statSync(access.canonical);
      if (!stat.isFile()) return null;
      if (stat.size > 20 * 1024 * 1024) return null;
      return fs.readFileSync(access.canonical).toString("base64");
    } catch {
      return null;
    }
  });
  wrapIpcHandler("read-docx-html", async (event, filePath) => {
    const access = canReadPath(event.sender, filePath);
    if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
    try {
      const stat = fs.statSync(access.canonical);
      if (!stat.isFile()) return null;
      if (stat.size > 20 * 1024 * 1024) return null;
      const mammoth = require("mammoth");
      const result = await mammoth.convertToHtml({ path: access.canonical });
      return result.value;
    } catch {
      return null;
    }
  });
  wrapIpcHandler("read-xlsx-html", async (event, filePath) => {
    const access = canReadPath(event.sender, filePath);
    if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
    try {
      const stat = fs.statSync(access.canonical);
      if (!stat.isFile()) return null;
      if (stat.size > 20 * 1024 * 1024) return null;
      const ExcelJS = require("exceljs");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(access.canonical);
      const sheet = workbook.worksheets[0];
      if (!sheet || sheet.rowCount === 0) return null;
      const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      let html = "<table>";
      sheet.eachRow((row) => {
        html += "<tr>";
        for (let i = 1; i <= sheet.columnCount; i++) {
          html += `<td>${esc(row.getCell(i).text)}</td>`;
        }
        html += "</tr>";
      });
      html += "</table>";
      return html;
    } catch {
      return null;
    }
  });
  wrapIpcHandler("grant-file-access", (event, filePath) => !!grantWebContentsAccess(event.sender, filePath, "read"));
  wrapIpcHandler("reload-main-window", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });
  function getNotificationPermissionStatus() {
    if (!Notification.isSupported()) return "unsupported";
    if (process.platform !== "darwin") return "granted";
    const settings = systemPreferences.getNotificationSettings?.();
    const status = settings?.authorizationStatus;
    if (status === "authorized" || status === "provisional" || status === "ephemeral") {
      return "granted";
    }
    if (status === "denied") return "denied";
    if (status === "not-determined") return "not-determined";
    return "granted";
  }
  async function requestNotificationPermission() {
    const currentStatus = getNotificationPermissionStatus();
    if (currentStatus !== "not-determined") return currentStatus;
    try {
      const notif = new Notification({
        title: "Lynn",
        body: mt("notification.ready", null, "Notifications enabled"),
        silent: true
      });
      notif.show();
    } catch {
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15e3) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const nextStatus = getNotificationPermissionStatus();
      if (nextStatus !== "not-determined") return nextStatus;
    }
    return getNotificationPermissionStatus();
  }
  wrapIpcHandler("get-notification-permission-status", () => getNotificationPermissionStatus());
  wrapIpcHandler("request-notification-permission", () => requestNotificationPermission());
  let _pendingNotificationCount = 0;
  wrapIpcHandler("show-notification", (_event, title, body) => {
    if (!Notification.isSupported()) return;
    const notif = new Notification({
      title: title || "Lynn",
      body: body || "",
      silent: false
    });
    notif.on("click", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notif.show();
    if (process.platform === "darwin" && mainWindow && (!mainWindow.isVisible() || !mainWindow.isFocused())) {
      _pendingNotificationCount++;
      app.dock.setBadge(String(_pendingNotificationCount));
    }
  });
  wrapIpcHandler("debug-open-onboarding", () => {
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.focus();
      return;
    }
    createOnboardingWindow();
  });
  wrapIpcHandler("debug-open-onboarding-preview", () => {
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.focus();
      return;
    }
    createOnboardingWindow({ preview: "1" });
  });
  wrapIpcHandler("onboarding-complete", async () => {
    return completeOnboardingAndOpenMain({ markSetupComplete: true });
  });
  wrapIpcHandler("get-platform", () => process.platform);
  wrapIpcHandler("window-minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  wrapIpcHandler("window-maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) win.restore();
    else win?.maximize();
  });
  wrapIpcHandler("window-close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  wrapIpcHandler("window-is-maximized", (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
  wrapIpcHandler("app-ready", () => {
    if (mainWindow) {
      mainWindow.show();
    }
    resolveMainWindowReady(true);
    setTimeout(() => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
      }
      if (onboardingWindow && !onboardingWindow.isDestroyed()) {
        onboardingWindow.close();
      }
    }, 200);
  });
  app.whenReady().then(async () => {
    const appMenu = Menu.buildFromTemplate([
      ...process.platform === "darwin" ? [{
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" }
        ]
      }] : [],
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" }
        ]
      }
    ]);
    Menu.setApplicationMenu(appMenu);
    try {
      createSplashWindow();
      const splashShownAt = Date.now();
      console.log("[desktop] 启动 Lynn Server...");
      await startServer();
      console.log(`[desktop] Server 就绪，端口: ${serverPort}`);
      monitorServer();
      setupBrowserCommands();
      createTray();
      const elapsed = Date.now() - splashShownAt;
      const minSplashMs = 1200;
      if (elapsed < minSplashMs) {
        await new Promise((r) => setTimeout(r, minSplashMs - elapsed));
      }
      if (isSetupComplete()) {
        createMainWindow();
      } else if (hasExistingConfig()) {
        console.log("[desktop] 检测到已有配置，跳到教程页");
        createOnboardingWindow({ skipToTutorial: "1" });
      } else {
        console.log("[desktop] 首次启动，显示 Onboarding 向导");
        createOnboardingWindow();
      }
      registerGlobalSummon();
      try {
        const prefsPath = path.join(lynnHome, "user", "preferences.json");
        if (fs.existsSync(prefsPath)) {
          const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
          if (prefs.update_channel) setUpdateChannel(prefs.update_channel);
        }
      } catch {
      }
      checkForUpdates().catch(() => {
      });
    } catch (err) {
      console.error("[desktop] 启动失败:", err.message);
      const crashInfo = writeCrashLog(err.message);
      const tail = crashInfo.length > 800 ? "...\n" + crashInfo.slice(-800) : crashInfo;
      dialog.showErrorBox(
        mt("dialog.launchFailedTitle", null, "Lynn Launch Failed"),
        mt("dialog.launchFailedBody", { detail: tail, logPath: path.join(lynnHome, "crash.log") })
      );
      forceQuitApp = true;
      app.quit();
    }
  });
  app.on("window-all-closed", () => {
    if (!tray || tray.isDestroyed()) {
      forceQuitApp = true;
      app.quit();
    }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
      if (isSetupComplete()) {
        createMainWindow();
      } else if (hasExistingConfig()) {
        createOnboardingWindow({ skipToTutorial: "1" });
      } else {
        createOnboardingWindow();
      }
    } else {
      showPrimaryWindow();
    }
  });
  function registerGlobalSummon() {
    const SHORTCUT = process.platform === "darwin" ? "Alt+Space" : "Alt+Space";
    const registered = globalShortcut.register(SHORTCUT, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isVisible() && mainWindow.isFocused()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send("global-summon");
        }
      } else {
        showPrimaryWindow();
      }
    });
    if (registered) {
      console.log(`[desktop] 全局快捷键 ${SHORTCUT} 已注册`);
    } else {
      console.warn(`[desktop] 全局快捷键 ${SHORTCUT} 注册失败（可能已被其他应用占用）`);
    }
  }
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
      tray = null;
    }
  });
  app.on("before-quit", async (event) => {
    isQuitting = true;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.hide();
    }
    for (const [sp, view] of _browserViews) {
      try {
        view.webContents.close();
      } catch {
      }
    }
    _browserViews.clear();
    _browserWebView = null;
    _currentBrowserSession = null;
    if (serverProcess && !serverProcess.killed) {
      event.preventDefault();
      console.log("[desktop] 正在关闭 Server...");
      if (process.platform === "win32") {
        try {
          await fetch(`http://127.0.0.1:${serverPort}/api/shutdown`, {
            method: "POST",
            headers: { Authorization: `Bearer ${serverToken}` },
            signal: AbortSignal.timeout(5e3)
          });
        } catch {
        }
      } else {
        try {
          serverProcess.kill("SIGTERM");
        } catch {
        }
      }
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (serverProcess && !serverProcess.killed) {
            serverProcess.kill();
          }
          resolve();
        }, 5e3);
        serverProcess.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      serverProcess = null;
      app.quit();
    } else if (reusedServerPid) {
      event.preventDefault();
      console.log("[desktop] 正在关闭复用的 Server...");
      try {
        await fetch(`http://127.0.0.1:${serverPort}/api/shutdown`, {
          method: "POST",
          headers: { Authorization: `Bearer ${serverToken}` },
          signal: AbortSignal.timeout(2e3)
        });
      } catch {
        killPid(reusedServerPid);
      }
      const deadline = Date.now() + 5e3;
      while (Date.now() < deadline) {
        try {
          process.kill(reusedServerPid, 0);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      killPid(reusedServerPid, true);
      reusedServerPid = null;
      app.quit();
    }
  });
  process.on("uncaughtException", (err) => {
    if (err.code === "EPIPE" || err.code === "ERR_IPC_CHANNEL_CLOSED") return;
    const traceId = Math.random().toString(16).slice(2, 10);
    console.error(`[ErrorBus][${err.code || "UNKNOWN"}][${traceId}] uncaughtException: ${err.message}`);
    console.error(`[ErrorBus][${traceId}] ${err.stack || err.message}`);
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    const traceId = Math.random().toString(16).slice(2, 10);
    console.error(`[ErrorBus][${err.code || "UNKNOWN"}][${traceId}] unhandledRejection: ${err.message}`);
    console.error(`[ErrorBus][${traceId}] ${err.stack || err.message}`);
  });
  return main$1;
}
var mainExports = requireMain();
const main = /* @__PURE__ */ getDefaultExportFromCjs(mainExports);
module.exports = main;
